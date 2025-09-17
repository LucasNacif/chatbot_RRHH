import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import qrcode from "qrcode-terminal"
import Pino from "pino"

const ADMIN = "5492613628979@s.whatsapp.net" 

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState("auth")


    const sock = makeWASocket({
        auth: state,
        browser: ["Ubuntu", "Chrome", "22.04.4"],
        logger: Pino({ level: "silent" })
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log("👉 Escaneá este QR con el *teléfono de la empresa*:")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            console.log("✅ Bot conectado con el número de la empresa")

            
            sock.sendMessage(ADMIN, { text: "🤖 Bot conectado y listo!" })
        }

        if (connection === "close") {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : null

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            console.log("❌ Conexión cerrada. Reconectar:", shouldReconnect)

            if (shouldReconnect) start()
        }
    })


    sock.ev.on("messages.upsert", async m => {
        const msg = m.messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            ""

        console.log(`📩 Mensaje recibido de ${from}: ${body}`)

        if (from === ADMIN && body.toLowerCase() === "ping") {
            await sock.sendMessage(from, { text: "pong 🏓" })
        }
    })
}

start()
