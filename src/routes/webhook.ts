// src/routes/webhook.ts
import { Router } from "express";
import * as controller from "../controllers/webhook";

const router = Router();

router.post("/", controller.handleWebhook);

export default router;