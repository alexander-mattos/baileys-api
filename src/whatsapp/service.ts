import makeWASocket, {
	DisconnectReason,
	isJidBroadcast,
	makeCacheableSignalKeyStore,
} from "baileys";
import type { ConnectionState, SocketConfig, WASocket, proto } from "baileys";
import { Store, useSession } from "./store";
import { prisma } from "@/config/database";
import { logger, delay, emitEvent } from "@/utils";
import { WAStatus } from "@/types";
import type { Boom } from "@hapi/boom";
import type { Response } from "express";
import { toDataURL } from "qrcode";
import type { WebSocket as WebSocketType } from "ws";
import env from "@/config/env";

// Contador para monitorar operações de banco ativas
let activeDbOperations = 0;
const MAX_CONCURRENT_DB_OPS = 20;

// Semáforo para limitar operações no banco
const dbSemaphore = {
	acquire: async function () {
		while (activeDbOperations >= MAX_CONCURRENT_DB_OPS) {
			await delay(50);
		}
		activeDbOperations++;
		return true;
	},
	release: function () {
		activeDbOperations--;
	}
};

export type Session = WASocket & {
	destroy: () => Promise<void>;
	store: Store;
	waStatus?: WAStatus;
};

type createSessionOptions = {
	sessionId: string;
	res?: Response;
	SSE?: boolean;
	readIncomingMessages?: boolean;
	socketConfig?: SocketConfig;
};

class WhatsappService {
	private static sessions = new Map<string, Session>();
	private static retries = new Map<string, number>();
	private static SSEQRGenerations = new Map<string, number>();
	private static isShuttingDown = false;
	private static cleanupInterval: NodeJS.Timeout;

	constructor() {
		this.init();
		this.setupCleanupInterval();
	}

	private setupCleanupInterval() {
		// Cancela o anterior caso exista
		if (WhatsappService.cleanupInterval) {
			clearInterval(WhatsappService.cleanupInterval);
		}

		// Configura o novo intervalo
		const SESSION_CLEANUP_INTERVAL = 2 * 60 * 60 * 1000; // 2 horas
		WhatsappService.cleanupInterval = setInterval(() => {
			if (!WhatsappService.isShuttingDown) {
				WhatsappService.checkAndCleanSessions()
					.catch(err => logger.error(err, 'Error in scheduled session cleanup'));
			}
		}, SESSION_CLEANUP_INTERVAL);
	}

	private async init() {
		try {
			await dbSemaphore.acquire();
			const storedSessions = await prisma.session.findMany({
				select: { sessionId: true, data: true },
				where: { id: { startsWith: env.SESSION_CONFIG_ID } },
			});

			// Inicializar sessões em lotes para não sobrecarregar o banco
			const batchSize = 3;
			for (let i = 0; i < storedSessions.length; i += batchSize) {
				const batch = storedSessions.slice(i, i + batchSize);

				await Promise.all(batch.map(async ({ sessionId, data }) => {
					try {
						const { readIncomingMessages, ...socketConfig } = JSON.parse(data);
						await WhatsappService.createSession({
							sessionId,
							readIncomingMessages,
							socketConfig
						});
					} catch (error) {
						logger.error(
							{ error, sessionId },
							"Failed to initialize session"
						);
					}
				}));

				// Pequeno delay entre lotes para não sobrecarregar
				if (i + batchSize < storedSessions.length) {
					await delay(1000);
				}
			}
		} catch (error) {
			logger.error(error, "Failed to initialize WhatsApp sessions");
		} finally {
			dbSemaphore.release();
		}
	}

	private static updateWaConnection(sessionId: string, waStatus: WAStatus) {
		if (WhatsappService.sessions.has(sessionId)) {
			const _session = WhatsappService.sessions.get(sessionId)!;
			WhatsappService.sessions.set(sessionId, { ..._session, waStatus });
			emitEvent("connection.update", sessionId, { status: waStatus });
		}
	}

	private static shouldReconnect(sessionId: string) {
		// Não tentar reconectar se estiver em processo de desligamento
		if (WhatsappService.isShuttingDown) {
			return false;
		}

		let attempts = WhatsappService.retries.get(sessionId) ?? 0;

		if (attempts < env.MAX_RECONNECT_RETRIES) {
			attempts += 1;
			WhatsappService.retries.set(sessionId, attempts);
			return true;
		}
		return false;
	}

	static async createSession(options: createSessionOptions) {
		// Não criar novas sessões durante desligamento
		if (WhatsappService.isShuttingDown) {
			logger.info(
				{ sessionId: options.sessionId },
				"Skipping session creation during shutdown"
			);
			return;
		}

		const { sessionId, res, SSE = false, readIncomingMessages = false, socketConfig } = options;
		const configID = `${env.SESSION_CONFIG_ID}-${sessionId}`;
		let connectionState: Partial<ConnectionState> = { connection: "close" };

		const destroy = async (logout = true) => {
			try {
				// Limitar operações concorrentes no banco
				await dbSemaphore.acquire();

				await Promise.all([
					logout && socket.logout().catch(err => logger.error(err, "Logout failed")),
					prisma.chat.deleteMany({ where: { sessionId } }),
					prisma.contact.deleteMany({ where: { sessionId } }),
					prisma.message.deleteMany({ where: { sessionId } }),
					prisma.groupMetadata.deleteMany({ where: { sessionId } }),
					prisma.session.deleteMany({ where: { sessionId } }),
				]);
				logger.info({ session: sessionId }, "Session destroyed");
			} catch (e) {
				logger.error(e, "An error occurred during session destroy");
			} finally {
				dbSemaphore.release();
				WhatsappService.sessions.delete(sessionId);
				WhatsappService.updateWaConnection(sessionId, WAStatus.Disconected);
			}
		};

		const handleConnectionClose = () => {
			const code = (connectionState.lastDisconnect?.error as Boom)?.output?.statusCode;
			const restartRequired = code === DisconnectReason.restartRequired;
			const doNotReconnect = !WhatsappService.shouldReconnect(sessionId);

			WhatsappService.updateWaConnection(sessionId, WAStatus.Disconected);

			if (code === DisconnectReason.loggedOut || doNotReconnect) {
				if (res) {
					!SSE &&
						!res.headersSent &&
						res.status(500).json({ error: "Unable to create session" });
					res.end();
				}
				destroy(doNotReconnect);
				return;
			}

			if (!restartRequired) {
				logger.info(
					{ attempts: WhatsappService.retries.get(sessionId) ?? 1, sessionId },
					"Reconnecting...",
				);
			}
			setTimeout(
				() => WhatsappService.createSession(options),
				restartRequired ? 0 : env.RECONNECT_INTERVAL,
			);
		};

		const handleNormalConnectionUpdate = async () => {
			if (connectionState.qr?.length) {
				if (res && !res.headersSent) {
					try {
						const qr = await toDataURL(connectionState.qr);
						WhatsappService.updateWaConnection(sessionId, WAStatus.WaitQrcodeAuth);
						emitEvent("qrcode.updated", sessionId, { qr });
						res.status(200).json({ qr });
						return;
					} catch (e) {
						logger.error(e, "An error occurred during QR generation");
						emitEvent(
							"qrcode.updated",
							sessionId,
							undefined,
							"error",
							`Unable to generate QR code: ${e instanceof Error ? e.message : String(e)}`,
						);
						res.status(500).json({ error: "Unable to generate QR" });
					}
				}
				destroy();
			}
		};

		const handleSSEConnectionUpdate = async () => {
			let qr: string | undefined = undefined;
			if (connectionState.qr?.length) {
				try {
					WhatsappService.updateWaConnection(sessionId, WAStatus.WaitQrcodeAuth);
					qr = await toDataURL(connectionState.qr);
				} catch (e) {
					logger.error(e, "An error occurred during QR generation");
					emitEvent(
						"qrcode.updated",
						sessionId,
						undefined,
						"error",
						`Unable to generate QR code: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			const currentGenerations = WhatsappService.SSEQRGenerations.get(sessionId) ?? 0;
			if (
				!res ||
				res.writableEnded ||
				(qr && currentGenerations >= env.SSE_MAX_QR_GENERATION)
			) {
				res && !res.writableEnded && res.end();
				destroy();
				return;
			}

			const data = { ...connectionState, qr };
			if (qr) {
				WhatsappService.SSEQRGenerations.set(sessionId, currentGenerations + 1);
				emitEvent("qrcode.updated", sessionId, { qr });
			}
			res.write(`data: ${JSON.stringify(data)}\n\n`);
		};

		const handleConnectionUpdate = SSE
			? handleSSEConnectionUpdate
			: handleNormalConnectionUpdate;

		// Obter a sessão do armazenamento
		let sessionState;
		try {
			await dbSemaphore.acquire();
			sessionState = await useSession(sessionId);
		} finally {
			dbSemaphore.release();
		}

		const { state, saveCreds } = sessionState;
		const socket = makeWASocket({
			printQRInTerminal: true,
			browser: [env.BOT_NAME || "Whatsapp Bot", "Chrome", "3.0"],
			generateHighQualityLinkPreview: true,
			...socketConfig,
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys, logger),
			},
			version: [2, 3000, 1015901307],
			logger,
			shouldIgnoreJid: (jid) => isJidBroadcast(jid),
			getMessage: async (key) => {
				try {
					await dbSemaphore.acquire();
					const data = await prisma.message.findFirst({
						where: { remoteJid: key.remoteJid!, id: key.id!, sessionId },
					});
					return (data?.message || undefined) as proto.IMessage | undefined;
				} finally {
					dbSemaphore.release();
				}
			},
		});

		const store = new Store(sessionId, socket.ev);

		WhatsappService.sessions.set(sessionId, {
			...socket,
			destroy,
			store,
			waStatus: WAStatus.Unknown,
		});

		socket.ev.on("creds.update", saveCreds);
		socket.ev.on("connection.update", (update) => {
			connectionState = update;
			const { connection } = update;

			if (connection === "open") {
				WhatsappService.updateWaConnection(
					sessionId,
					update.isNewLogin ? WAStatus.Authenticated : WAStatus.Connected,
				);
				WhatsappService.retries.delete(sessionId);
				WhatsappService.SSEQRGenerations.delete(sessionId);
			}
			if (connection === "close") handleConnectionClose();
			if (connection === "connecting")
				WhatsappService.updateWaConnection(sessionId, WAStatus.PullingWAData);
			handleConnectionUpdate();
		});

		if (readIncomingMessages) {
			socket.ev.on("messages.upsert", async (m) => {
				const message = m.messages[0];
				if (message.key.fromMe || m.type !== "notify") return;

				await delay(1000);
				await socket.readMessages([message.key]);
			});
		}

		try {
			await dbSemaphore.acquire();
			await prisma.session.upsert({
				create: {
					id: configID,
					sessionId,
					data: JSON.stringify({ readIncomingMessages, ...socketConfig }),
				},
				update: {},
				where: { sessionId_id: { id: configID, sessionId } },
			});
		} catch (error) {
			logger.error(error, "Failed to save session config");
		} finally {
			dbSemaphore.release();
		}
	}

	static getSessionStatus(session: Session) {
		const state = ["CONNECTING", "CONNECTED", "DISCONNECTING", "DISCONNECTED"];
		let status = state[((session.ws as unknown) as WebSocketType).readyState];
		status = session.user ? "AUTHENTICATED" : status;
		return session.waStatus !== WAStatus.Unknown ? session.waStatus : status.toLowerCase();
	}

	static listSessions() {
		return Array.from(WhatsappService.sessions.entries()).map(([id, session]) => ({
			id,
			status: WhatsappService.getSessionStatus(session),
		}));
	}

	static getSession(sessionId: string) {
		return WhatsappService.sessions.get(sessionId);
	}

	static async deleteSession(sessionId: string) {
		WhatsappService.sessions.get(sessionId)?.destroy();
	}

	static sessionExists(sessionId: string) {
		return WhatsappService.sessions.has(sessionId);
	}

	static async validJid(session: Session, jid: string, type: "group" | "number" = "number") {
		try {
			if (type === "number") {
				const [result] = await session.onWhatsApp(jid);
				if (result?.exists) {
					return result.jid;
				} else {
					return null;
				}
			}

			const groupMeta = await session.groupMetadata(jid);
			if (groupMeta.id) {
				return groupMeta.id;
			} else {
				return null;
			}
		} catch (e) {
			return null;
		}
	}

	static async jidExists(session: Session, jid: string, type: "group" | "number" = "number") {
		const validJid = await this.validJid(session, jid, type);
		return !!validJid;
	}

	/**
   * Fecha todas as sessões do WhatsApp de forma limpa
   * Uso: durante desligamento gracioso do servidor
   */
	static async closeAllSessions(): Promise<void> {
		logger.info('Starting graceful shutdown of all WhatsApp sessions');

		// Sinalizar que estamos em processo de desligamento
		WhatsappService.isShuttingDown = true;

		try {
			const sessionIds = Array.from(WhatsappService.sessions.keys());
			logger.info({ count: sessionIds.length }, 'Closing WhatsApp sessions');

			// Processar sessões em lotes para não sobrecarregar o banco
			const batchSize = 5;
			for (let i = 0; i < sessionIds.length; i += batchSize) {
				const batch = sessionIds.slice(i, i + batchSize);

				await Promise.all(
					batch.map(async (sessionId) => {
						try {
							logger.info({ sessionId }, 'Closing session');
							await WhatsappService.deleteSession(sessionId);
						} catch (error) {
							logger.error({ error, sessionId }, 'Error closing session');
						}
					})
				);

				// Pequeno delay entre lotes
				if (i + batchSize < sessionIds.length) {
					await delay(1000);
				}
			}

			// Limpar todas as coleções
			WhatsappService.retries.clear();
			WhatsappService.SSEQRGenerations.clear();

			logger.info('All WhatsApp sessions closed successfully');
		} catch (error) {
			logger.error(error, 'Error closing WhatsApp sessions');
			throw error;
		}
	}

	/**
	 * Método para verificar e corrigir vazamento de sessões
	 * Pode ser chamado periodicamente para garantir limpeza de recursos
	 */
	static async checkAndCleanSessions(): Promise<void> {
		logger.info('Checking for session leaks');

		try {
			// Obter todas as sessões do banco
			await dbSemaphore.acquire();
			const storedSessions = await prisma.session.findMany({
				select: { sessionId: true },
				where: { id: { startsWith: env.SESSION_CONFIG_ID } },
			});

			const dbSessionIds = new Set(storedSessions.map(s => s.sessionId));
			const memorySessionIds = new Set(WhatsappService.sessions.keys());

			// Encontrar sessões no banco que não estão na memória
			for (const sessionId of dbSessionIds) {
				if (!memorySessionIds.has(sessionId)) {
					logger.info({ sessionId }, 'Cleaning orphaned database session');

					try {
						await prisma.chat.deleteMany({ where: { sessionId } });
						await prisma.contact.deleteMany({ where: { sessionId } });
						await prisma.message.deleteMany({ where: { sessionId } });
						await prisma.groupMetadata.deleteMany({ where: { sessionId } });
						await prisma.session.deleteMany({ where: { sessionId } });
					} catch (error) {
						logger.error({ error, sessionId }, 'Error cleaning orphaned session');
					}
				}
			}

			// Encontrar sessões na memória que não estão no banco
			for (const sessionId of memorySessionIds) {
				if (!dbSessionIds.has(sessionId)) {
					logger.info({ sessionId }, 'Cleaning orphaned memory session');

					try {
						WhatsappService.sessions.delete(sessionId);
						WhatsappService.retries.delete(sessionId);
						WhatsappService.SSEQRGenerations.delete(sessionId);
					} catch (error) {
						logger.error({ error, sessionId }, 'Error cleaning orphaned memory session');
					}
				}
			}

			logger.info('Session cleanup completed');
		} catch (error) {
			logger.error(error, 'Error during session cleanup');
		} finally {
			dbSemaphore.release();
		}
	}
}

export default WhatsappService;