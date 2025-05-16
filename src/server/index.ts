import http from "http";
import { ExpressServer } from "./express-server";
import env from "@/config/env";
import { SocketServer } from "./websocket-server";
import WhatsappService from "@/whatsapp/service";
import { initializeSocketEmitter } from "@/utils";
import { prisma } from "@/config/database";
import { logger } from "@/utils";

export class Server {
	private httpServer: ExpressServer;
	private socketServer: SocketServer;
	private httpPort = env.PORT;
	private server: http.Server;
	private whatsappService: WhatsappService;

	constructor() {
		this.httpServer = new ExpressServer();
		this.server = http.createServer(this.httpServer.getApp());
		this.setupSocketServer();
	}

	private setupSocketServer() {
		if (env.ENABLE_WEBSOCKET) {
			this.socketServer = new SocketServer(this.server);
		}
	}

	public async start(): Promise<void> {
		// Initialize WhatsApp connection
		this.whatsappService = new WhatsappService();

		this.server.listen(this.httpPort, () => {
			console.log(`Server is running on port ${this.httpPort}`);
		});

		if (this.socketServer) {
			initializeSocketEmitter(this.socketServer);
			console.log("WebSocket server is running");
		}

		// Configurar manipuladores de desligamento gracioso
		this.setupGracefulShutdown();
	}

	/**
	 * Configura manipuladores para desligamento gracioso do servidor
	 */
	private setupGracefulShutdown(): void {
		// Função para desligamento gracioso
		const gracefulShutdown = async (signal: string) => {
			logger.info(`Received ${signal}. Starting graceful shutdown...`);

			// Definir um timeout para garantir encerramento após 30 segundos
			const forceExit = setTimeout(() => {
				logger.error('Forcing exit after timeout');
				process.exit(1);
			}, 30000);

			try {
				// 1. Primeiro parar de aceitar novas conexões
				logger.info('Closing HTTP server');
				await new Promise<void>((resolve) => {
					this.server.close(() => resolve());
				});

				// 2. Desligar WebSocket se estiver ativo
				if (this.socketServer) {
					logger.info('Closing WebSocket server');
					await this.socketServer.close();
				}

				// 3. Encerrar o serviço do WhatsApp
				if (this.whatsappService) {
					logger.info('Closing WhatsApp connections');
					await this.whatsappService.closeAllSessions();
				}

				// 4. Desconectar o Prisma no final
				logger.info('Disconnecting from database');
				await prisma.$disconnect();

				// Limpar o timeout de força
				clearTimeout(forceExit);

				logger.info(`Graceful shutdown completed.`);
				process.exit(0);
			} catch (error) {
				logger.error(error, 'Error during graceful shutdown');
				clearTimeout(forceExit);
				process.exit(1);
			}
		};

		// Registrar os manipuladores para os sinais de encerramento
		process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
		process.on('SIGINT', () => gracefulShutdown('SIGINT'));

		// Capturar exceções não tratadas
		process.on('uncaughtException', (error) => {
			logger.error(error, 'Uncaught exception');
			gracefulShutdown('UNCAUGHT_EXCEPTION');
		});

		// Capturar rejeições de promessas não tratadas
		process.on('unhandledRejection', (reason) => {
			logger.error({ reason }, 'Unhandled rejection');
			gracefulShutdown('UNHANDLED_REJECTION');
		});
	}
}