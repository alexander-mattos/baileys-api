import { Router } from "express";
import chatRoutes from "./chats";
import groupRoutes from "./groups";
import messageRoutes from "./messages";
import sessionRoutes from "./sessions";
import contactRoutes from "./contacts";
import { apiKeyValidator } from "@/middlewares/api-key-validator";
import webhookRoutes from "./webhook";

const router = Router();
router.use("/api", apiKeyValidator); // Middleware para validar a chave da API em todas as rotas
router.use("/chats", chatRoutes);
router.use("/groups", groupRoutes);
router.use("/messages", messageRoutes);
router.use("/contacts", contactRoutes);
router.use("/sessions", sessionRoutes);
router.use("/:sessionId/chats", apiKeyValidator, chatRoutes);
router.use("/:sessionId/contacts", apiKeyValidator, contactRoutes);
router.use("/:sessionId/groups", apiKeyValidator, groupRoutes);
router.use("/:sessionId/messages", apiKeyValidator, messageRoutes);
router.use("/webhook", webhookRoutes);

export default router;
