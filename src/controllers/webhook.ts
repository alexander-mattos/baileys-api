// src/controllers/webhook.ts
import type { Request, Response } from "express";
import { logger } from "../utils/logger";

export const handleWebhook = async (req: Request, res: Response) => {
    try {
        const webhook = req.body;
        logger.info("Webhook received:", webhook);

        // Processar o webhook conforme necessário
        // Por exemplo, se for um status de sessão, qrcode, mensagem...

        return res.status(200).json({
            success: true,
            message: "Webhook received successfully"
        });
    } catch (error) {
        logger.error("Error handling webhook:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to process webhook"
        });
    }
};