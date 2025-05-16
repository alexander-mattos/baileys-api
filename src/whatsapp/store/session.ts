/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { proto } from "baileys";
import { BufferJSON, initAuthCreds } from "baileys";
import { prisma } from "@/config/database";
import { logger } from "@/utils";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

// Cache para controlar frequência de escritas
const sessionWriteCache = new Map<string, number>();
const WRITE_INTERVAL = 3000; // Limite para 3 segundos entre escritas do mesmo ID

// Contador para monitorar operações ativas no banco
let activeDbOperations = 0;
const MAX_CONCURRENT_OPS = 10; // Limitar operações concorrentes

const fixId = (id: string) => id.replace(/\//g, "__").replace(/:/g, "-");

export async function useSession(sessionId: string): Promise<{
	state: AuthenticationState;
	saveCreds: () => Promise<void>;
}> {
	const model = prisma.session;

	// Função otimizada para escrita com throttling
	const write = async (data: any, id: string) => {
		try {
			const now = Date.now();
			const cacheKey = `${sessionId}-${id}`;
			const lastWrite = sessionWriteCache.get(cacheKey) || 0;

			// Só escreve se passou o intervalo mínimo desde a última escrita
			if (now - lastWrite < WRITE_INTERVAL) {
				return;
			}

			// Atualiza o timestamp da última escrita
			sessionWriteCache.set(cacheKey, now);

			// Limitar número de operações concorrentes
			if (activeDbOperations >= MAX_CONCURRENT_OPS) {
				logger.warn(
					{ id, activeOps: activeDbOperations },
					"Too many concurrent DB operations, waiting..."
				);
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			activeDbOperations++;

			data = JSON.stringify(data, BufferJSON.replacer);
			id = fixId(id);

			await model.upsert({
				select: { pkId: true },
				create: { data, id, sessionId },
				update: { data },
				where: { sessionId_id: { id, sessionId } },
			});
		} catch (e) {
			logger.error(e, "An error occured during session write");
		} finally {
			activeDbOperations--;
		}
	};

	// Função de leitura otimizada
	const read = async (id: string) => {
		try {
			// Limitar número de operações concorrentes
			if (activeDbOperations >= MAX_CONCURRENT_OPS) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			activeDbOperations++;

			const result = await model.findUnique({
				select: { data: true },
				where: { sessionId_id: { id: fixId(id), sessionId } },
			});

			if (!result) {
				logger.info({ id }, "Trying to read non existent session data");
				return null;
			}

			return JSON.parse(result.data, BufferJSON.reviver);
		} catch (e) {
			if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
				logger.info({ id }, "Trying to read non existent session data");
			} else {
				logger.error(e, "An error occured during session read");
			}
			return null;
		} finally {
			activeDbOperations--;
		}
	};

	// Função de exclusão otimizada
	const del = async (id: string) => {
		try {
			// Limitar número de operações concorrentes
			if (activeDbOperations >= MAX_CONCURRENT_OPS) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			activeDbOperations++;

			await model.delete({
				select: { pkId: true },
				where: { sessionId_id: { id: fixId(id), sessionId } },
			});
		} catch (e) {
			logger.error(e, "An error occured during session delete");
		} finally {
			activeDbOperations--;
		}
	};

	// Função para limpar o cache periódicamente
	const cleanupCache = () => {
		const now = Date.now();
		const expiredTime = now - (WRITE_INTERVAL * 10); // 10x o intervalo

		for (const [key, timestamp] of sessionWriteCache.entries()) {
			if (timestamp < expiredTime) {
				sessionWriteCache.delete(key);
			}
		}
	};

	// Configurar limpeza de cache a cada 5 minutos
	setInterval(cleanupCache, 5 * 60 * 1000);

	const creds: AuthenticationCreds = (await read("creds")) || initAuthCreds();

	return {
		state: {
			creds,
			keys: {
				get: async <T extends keyof SignalDataTypeMap>(
					type: T,
					ids: string[],
				): Promise<{
					[id: string]: SignalDataTypeMap[T];
				}> => {
					const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};

					// Otimização: Limitar concorrência usando chunks
					const chunkSize = 5;
					for (let i = 0; i < ids.length; i += chunkSize) {
						const chunk = ids.slice(i, i + chunkSize);
						await Promise.all(
							chunk.map(async (id) => {
								let value = await read(`${type}-${id}`);
								if (type === "app-state-sync-key" && value) {
									value = proto.Message.AppStateSyncKeyData.fromObject(value);
								}
								data[id] = value;
							}),
						);
					}

					return data;
				},
				set: async (data: any): Promise<void> => {
					const tasks: Promise<void>[] = [];
					let taskCount = 0;

					for (const category in data) {
						for (const id in data[category]) {
							const value = data[category][id];
							const sId = `${category}-${id}`;

							// Otimização: Processar em lotes para não sobrecarregar o banco
							if (taskCount >= MAX_CONCURRENT_OPS) {
								await Promise.all(tasks);
								tasks.length = 0;
								taskCount = 0;
							}

							tasks.push(value ? write(value, sId) : del(sId));
							taskCount++;
						}
					}

					await Promise.all(tasks);
				},
			},
		},
		saveCreds: () => write(creds, "creds"),
	};
}

// Limpar cache e recursos ao desligar
process.on('SIGINT', async () => {
	logger.info('Cleaning up session resources...');
	sessionWriteCache.clear();
	setTimeout(() => process.exit(0), 500);
});