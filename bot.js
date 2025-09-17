import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import qrcode from "qrcode-terminal"
import Pino from "pino"
import fs from "fs"

const ADMIN = "206119809089706@lid" 

//238138756755627 cris

const DIFFUSION_FILE = "diffusion.json"
let diffusionList = []
let isDiffusionActive = false

async function loadDiffusion() {
    if (fs.existsSync(DIFFUSION_FILE)) {
        try {
            diffusionList = JSON.parse(fs.readFileSync(DIFFUSION_FILE, "utf8"))
            console.log("✅ Lista de difusión cargada desde archivo")
        } catch (err) {
            console.error("❌ Error al cargar difusión:", err)
        }
    }
}

function saveDiffusion() {
    fs.writeFileSync(DIFFUSION_FILE, JSON.stringify(diffusionList, null, 2))
    console.log("✅ Lista de difusión guardada en archivo")
}

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState("auth")

    const sock = makeWASocket({
        auth: state,
        browser: ["Ubuntu", "Chrome", "22.04.4"],
        logger: Pino({ level: "silent" }) // Usamos "silent" para suprimir logs internos
    })

    await loadDiffusion()

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
        const from = msg.key.remoteJid
        const body =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            ""

        // Log temporal para identificar JIDs (solo mensajes entrantes con contenido)
        // if (!msg.key.fromMe && body) {
        //     console.log(`📬 JID recibido: ${from}, Mensaje: ${body}`)
        // }

        if (!msg.message || msg.key.fromMe) return

        if (from === ADMIN) {
            console.log(`📩 Mensaje recibido de ADMIN ${from}: ${body}`)
        } else {
            console.log(`🚫 Mensaje ignorado de ${from} (no es admin)`)
            return
        }

        const lowerBody = body.toLowerCase().trim()

        if (lowerBody.startsWith("agregar difusion")) {
            const content = body.slice("agregar difusion".length).trim()
            const numbers = content.split("\n").map(n => n.trim()).filter(n => n)
            
            const validNumbers = []
            for (const num of numbers) {
                const jid = `${num}@s.whatsapp.net`
                try {
                    const [result] = await sock.onWhatsApp(jid)
                    if (result?.exists) {
                        validNumbers.push(result.jid)
                    }
                } catch (err) {
                    console.error(`❌ Error validando ${num}:`, err)
                }
            }
            
            diffusionList.push(...validNumbers)
            await sock.sendMessage(from, { text: `✅ Agregados ${validNumbers.length} números válidos a la lista de difusión.` })
        } else if (lowerBody === "listar difusion") {
            const listText = diffusionList.length > 0 ? diffusionList.join("\n") : "La lista de difusión está vacía."
            await sock.sendMessage(from, { text: listText })
        } else if (lowerBody.startsWith("iniciar difusion")) {
            const message = body.slice("iniciar difusion".length).trim()
            if (!message) {
                await sock.sendMessage(from, { text: "❌ Debes proporcionar un mensaje después de 'iniciar difusion'." })
                return
            }
            
            if (diffusionList.length === 0) {
                await sock.sendMessage(from, { text: "❌ La lista de difusión está vacía." })
                return
            }

            if (isDiffusionActive) {
                await sock.sendMessage(from, { text: "❌ Ya hay una difusión en curso. Cancela la actual con 'cancelar difusion' antes de iniciar una nueva." })
                return
            }

            isDiffusionActive = true
            await sock.sendMessage(from, { text: "✅ Iniciando difusión... (respetando horario 8-20hs, límites y throttling). Usa 'cancelar difusion' para detenerla." })
            
            for (let i = 0; i < diffusionList.length && isDiffusionActive; i++) {
                const to = diffusionList[i]
                const now = new Date()
                const hour = now.getHours()
                
                if (hour >= 8 && hour < 20) {
                    try {
                        await sock.sendMessage(to, { text: message })
                        console.log(`✅ Mensaje enviado a ${to}`)
                        await new Promise(resolve => setTimeout(resolve, 5000))
                    } catch (err) {
                        console.error(`❌ Error enviando a ${to}:`, err)
                    }
                } else {
                    console.log(`⏰ Skip ${to}: fuera de horario`)
                }
            }
            
            if (isDiffusionActive) {
                isDiffusionActive = false
                await sock.sendMessage(from, { text: "✅ Difusión completada." })
            }
        } else if (lowerBody === "cancelar difusion") {
            const wasActive = isDiffusionActive
            isDiffusionActive = false
            diffusionList = []
            const response = wasActive
                ? "✅ Difusión en curso cancelada y lista de difusión limpiada."
                : "✅ Lista de difusión cancelada y limpiada."
            await sock.sendMessage(from, { text: response })
        } else if (lowerBody === "guardar difusion") {
            saveDiffusion()
            await sock.sendMessage(from, { text: "✅ Estado de difusión guardado en archivo." })
        } else if (lowerBody === "cargar difusion") {
            await loadDiffusion()
            await sock.sendMessage(from, { text: "✅ Estado de difusión cargado desde archivo." })
        } else if (lowerBody === "ping") {
            await sock.sendMessage(from, { text: "pong 🏓" })
        } else {
            await sock.sendMessage(from, { text: "❓ Comando no reconocido. Usa: ping, agregar difusion, listar difusion, iniciar difusion, cancelar difusion, guardar difusion, cargar difusion" })
        }
    })
}

start()