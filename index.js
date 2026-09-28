#!/usr/bin/env node
import http from "node:http";
import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const TEMPLATE_ID =
    process.env.TEMPLATE_ID || "1da_HX4QHcxkJXrXr5NQy0cDloKGMdGZKKhfgzPjoluM";

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Environment variable ${name} is not set`);
    return value;
}

function getAuth() {
    const auth = google.auth.fromJSON({
        type: "authorized_user",
        client_id: requireEnv("GOOGLE_CLIENT_ID"),
        client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
        refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN")
    });

    auth.scopes = [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents"
    ];

    return auth;
}

async function templateFill({ payment }) {
    const auth = getAuth();
    const drive = google.drive({ version: "v3", auth });
    const docs = google.docs({ version: "v1", auth });

    const copyResponse = await drive.files.copy({
        fileId: TEMPLATE_ID,
        requestBody: {
            name: `Платежное поручение ${payment.documentNumber || ""}`.trim()
        },
        fields: "id,name,mimeType"
    });

    const documentID = copyResponse.data.id;

    const replacements = {
        recipientTaxId: payment.recipientTaxId,
        recipientAccount: payment.recipientAccount,
        recipientBankName: payment.recipientBankName,
        recipientBankMfo: payment.recipientBankMfo,
        recipientName: payment.recipientName,
        amount: payment.amount,
        purpose: payment.purpose,
        purposeCode: payment.purposeCode,
        debitAccount: payment.debitAccount,
        documentDate: payment.documentDate,
        documentNumber: payment.documentNumber,
        viaAnor: payment.viaAnor
    };

    const requests = Object.entries(replacements).map(([key, value]) => ({
        replaceAllText: {
            containsText: { text: `{{${key}}}`, matchCase: true },
            replaceText: value === null || value === undefined ? "" : String(value)
        }
    }));

    await docs.documents.batchUpdate({
        documentId: documentID,
        requestBody: { requests }
    });

    return `https://docs.google.com/document/d/${documentID}/edit`;
}

const field = z.union([z.string(), z.number(), z.boolean()]).nullable().optional();

const paymentSchema = z.object({
    recipientTaxId: field.describe("ИНН получателя"),
    recipientAccount: field.describe("Расчётный счёт получателя"),
    recipientBankName: field.describe("Наименование банка получателя"),
    recipientBankMfo: field.describe("МФО банка получателя"),
    recipientName: field.describe("Наименование получателя"),
    amount: field.describe("Сумма платежа"),
    purpose: field.describe("Назначение платежа"),
    purposeCode: field.describe("Код назначения платежа"),
    debitAccount: field.describe("Счёт списания (плательщика)"),
    documentDate: field.describe("Дата документа"),
    documentNumber: field.describe("Номер документа"),
    viaAnor: field.describe("Платёж через ANOR")
});

function createServer() {
    const server = new McpServer({ name: "unistar-mcp", version: "1.0.0" });

    server.registerTool(
        "template_fill",
        {
            title: "Создать платёжное поручение",
            description:
                "Копирует шаблон платёжного поручения в Google Docs, подставляет реквизиты платежа " +
                "вместо плейсхолдеров {{...}} и возвращает ссылку на готовый документ.",
            inputSchema: { payment: paymentSchema }
        },
        async ({ payment }) => {
            try {
                const url = await templateFill({ payment });
                return { content: [{ type: "text", text: url }] };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Ошибка: ${error.message}` }]
                };
            }
        }
    );

    return server;
}

async function startStdio() {
    await createServer().connect(new StdioServerTransport());
    console.error("unistar-mcp running on stdio");
}

function isAuthorized(req, url, token) {
    if (!token) return true;
    const provided =
        url.searchParams.get("token") ||
        (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return provided === token;
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Streamable HTTP, stateless: a fresh server and transport for every request
async function handleStreamableHttp(req, res) {
    if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
        return;
    }

    let body;
    try {
        body = await readJson(req);
    } catch {
        res.writeHead(400).end("Invalid JSON");
        return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
        transport.close();
        server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
}

// Legacy SSE: GET /sse opens the stream, POST /message?sessionId= delivers messages
const sseTransports = new Map();

async function handleSseConnect(req, res) {
    const server = createServer();
    const transport = new SSEServerTransport("/message", res);
    sseTransports.set(transport.sessionId, transport);
    res.on("close", () => {
        sseTransports.delete(transport.sessionId);
        server.close();
    });

    await server.connect(transport);
}

async function handleSseMessage(req, res, url) {
    const transport = sseTransports.get(url.searchParams.get("sessionId"));
    if (!transport) {
        res.writeHead(400).end("Session not found or expired");
        return;
    }

    await transport.handlePostMessage(req, res);
}

function startHttp() {
    const port = Number(process.env.PORT || 3000);
    const token = process.env.MCP_AUTH_TOKEN;

    const httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        console.error(`${new Date().toISOString()} - ${req.method} ${url.pathname}`);

        try {
            if (url.pathname === "/health" && req.method === "GET") {
                res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
            } else if (url.pathname === "/message" && req.method === "POST") {
                // No token check: the sessionId is only issued on an authorized /sse connection
                await handleSseMessage(req, res, url);
            } else if (url.pathname !== "/mcp" && url.pathname !== "/sse") {
                res.writeHead(404).end("Not found");
            } else if (!isAuthorized(req, url, token)) {
                res.writeHead(401).end("Unauthorized");
            } else if (url.pathname === "/sse" && req.method === "GET") {
                await handleSseConnect(req, res);
            } else if (url.pathname === "/mcp") {
                await handleStreamableHttp(req, res);
            } else {
                res.writeHead(405).end("Method not allowed");
            }
        } catch (error) {
            console.error(error);
            if (!res.headersSent) res.writeHead(500).end("Internal server error");
        }
    });

    httpServer.listen(port, () => {
        console.error(`unistar-mcp listening on port ${port}`);
        console.error(`  Streamable HTTP: http://localhost:${port}/mcp`);
        console.error(`  SSE:             http://localhost:${port}/sse`);
        console.error(`  Health:          http://localhost:${port}/health`);
    });
}

if (process.env.MCP_TRANSPORT === "stdio" || process.argv.includes("--stdio")) {
    await startStdio();
} else {
    startHttp();
}
