// src/lib/prisma-client.ts
import { PrismaClient } from '@prisma/client';

// Variável global para armazenar uma única instância
declare global {
    var prismaClient: PrismaClient | undefined;
}

// Criar uma única instância para todo o aplicativo
export const prisma = global.prismaClient || new PrismaClient({
    log: ['error', 'warn'],
    // Configurações para otimizar conexões
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
});

// Salvar a instância no escopo global em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
    global.prismaClient = prisma;
}
