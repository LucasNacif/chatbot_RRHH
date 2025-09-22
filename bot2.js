import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import qrcode from "qrcode-terminal"
import Pino from "pino"
import fs from "fs"

// Lista de administradores (JIDs del canal y chat individual)
const ADMINS = [
    "206119809089706@lid", // Lucas (+542613628979, canal)
    "238138756755627@lid", // Cris (+542612519570, canal)
    "5492613628979@s.whatsapp.net", // Lucas (chat individual)
    "5492612519570@s.whatsapp.net" // Cris (chat individual)
];
const DIFFUSION_FILE = "diffusion.json"
let diffusionList = [];
let isDiffusionActive = false;
let isFirstConnection = true; 

function isBusinessHours() {
    const now = new Date();
    const day = now.getDay(); 
    const hour = now.getHours();
    return day >= 1 && day <= 5 && hour >= 9 && hour < 21;
}

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
        logger: Pino({ level: "silent" })
    })

    await loadDiffusion()

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log("👉 Escaneá este QR con el *teléfono de la empresa*:")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            if (isFirstConnection) {
                console.log("✅ Bot conectado con el número de la empresa (primera conexión)")
                if (isBusinessHours()) {
                    for (const admin of ADMINS) {
                        try {
                            await sock.sendMessage(admin, { text: "✅ Bot iniciado y conectado con el número de la empresa" })
                            console.log(`✅ Mensaje de inicio enviado al admin ${admin}`)
                        } catch (err) {
                            console.error(`❌ Error enviando mensaje de inicio al admin ${admin}:`, err)
                        }
                    }
                } else {
                    console.log(`⏰ No se envía mensaje de inicio: fuera del horario laboral (lunes a viernes, 9 a 21 hs)`)
                }
                isFirstConnection = false; 
            } else {
                console.log("ℹ️ Bot reconectado")
            }
        }

        if (connection === "close") {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : null

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            console.log(`❌ Conexión cerrada. StatusCode: ${statusCode}, Reconectar: ${shouldReconnect}`)

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

        if (!msg.message || msg.key.fromMe) return

        if (ADMINS.includes(from)) {
            console.log(`📩 Mensaje recibido de ADMIN ${from}: ${body}`)
        } else {
            console.log(`🚫 Mensaje ignorado de ${from} (no es admin)`)
            return
        }

        // Verificar horario laboral antes de procesar comandos
        if (!isBusinessHours()) {
            try {
                await sock.sendMessage(from, { text: "❌ El bot está inactivo fuera del horario laboral (lunes a viernes, 9 a 21 hs)." })
                console.log(`⏰ Comando ignorado: fuera del horario laboral (lunes a viernes, 9 a 21 hs)`)
            } catch (err) {
                console.error(`❌ Error enviando respuesta de horario al admin ${from}:`, err)
            }
            return
        }

        const lowerBody = body.toLowerCase().trim()
        let commandExecuted = false

        if (lowerBody.startsWith("agregar difusion")) {
            const content = body.slice("agregar difusion".length).trim()
            const numbers = content.split("\n").map(n => n.trim()).filter(n => n)
            // Filtrar duplicados
            const uniqueNumbers = [...new Set(numbers)]
            
            const validNumbers = []
            const invalidNumbers = []
            for (const num of uniqueNumbers) {
                // Normalizar número: quitar espacios, guiones, paréntesis, puntos, y el signo +
                let cleanNum = num.replace(/[\s-+().]/g, '')
                // Reemplazar 54 por 549 si está presente
                if (cleanNum.startsWith('54') && !cleanNum.startsWith('549')) {
                    cleanNum = `549${cleanNum.slice(2)}`
                    console.log(`ℹ️ Reemplazado prefijo 54 por 549 para ${num} → ${cleanNum}`)
                }
                // Agregar prefijo 549 si el número parece argentino
                if (cleanNum.match(/^(?:11|220|221|223|230|236|237|239|249|260|261|262|263|264|265|266|280|290|291|292|294|295|296|297|298|299|332|341|342|343|344|345|346|347|348|349|351|352|353|354|357|358|362|364|365|370|371|372|373|374|375|376|377|378|379|380|381|382|383|384|385|386|387|388|389)\d{7}$/)) {
                    cleanNum = `549${cleanNum}`
                    console.log(`ℹ️ Agregado prefijo 549 a ${num} → ${cleanNum}`)
                }
                // Validar formato
                if (!cleanNum.match(/^\d{10,15}$/)) {
                    invalidNumbers.push(`${num} (formato inválido)`)
                    console.log(`❌ Número con formato inválido: ${num}`)
                    continue
                }
                const jid = `${cleanNum}@s.whatsapp.net`
                let attempts = 0
                let success = false
                while (attempts < 2 && !success) {
                    try {
                        const [result] = await sock.onWhatsApp(jid)
                        if (result?.exists) {
                            validNumbers.push(result.jid)
                            console.log(`✅ Número válido agregado: ${cleanNum}`)
                            success = true
                        } else {
                            invalidNumbers.push(`${num} (no registrado en WhatsApp)`)
                            console.log(`❌ Número no registrado en WhatsApp: ${num} (${jid})`)
                            break
                        }
                    } catch (err) {
                        attempts++
                        if (attempts == 2) {
                            invalidNumbers.push(`${num} (error de validación: ${err.message})`)
                            console.error(`❌ Error validando ${num} (${jid}) después de ${attempts} intentos:`, err)
                        } else {
                            console.log(`⚠️ Reintentando validación de ${num} (${jid}), intento ${attempts + 1}`)
                            await new Promise(resolve => setTimeout(resolve, 1000))
                        }
                    }
                }
            }
            
            diffusionList.push(...validNumbers)
            let response = `✅ Agregados ${validNumbers.length} números válidos a la lista de difusión${validNumbers.length > 0 ? `: ${validNumbers.map(jid => jid.split('@')[0]).join(", ")}` : ''}.`
            if (invalidNumbers.length > 0) {
                response += `\n❌ Números no agregados: ${invalidNumbers.join(", ")}`
            }
            try {
                await sock.sendMessage(from, { text: response })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            commandExecuted = true
            console.log(`✅ Comando 'agregar difusion' ejecutado exitosamente`)
        } else if (lowerBody === "listar difusion") {
            const listText = diffusionList.length > 0 ? diffusionList.join("\n") : "La lista de difusión está vacía."
            try {
                await sock.sendMessage(from, { text: listText })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            commandExecuted = true
            console.log(`✅ Comando 'listar difusion' ejecutado exitosamente`)
        } else if (lowerBody.startsWith("iniciar difusion")) {
            const message = body.slice("iniciar difusion".length).trim()
            if (!message) {
                try {
                    await sock.sendMessage(from, { text: "❌ Debes proporcionar un mensaje después de 'iniciar difusion'." })
                } catch (err) {
                    console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
                }
                console.log(`❌ Comando 'iniciar difusion' falló: mensaje vacío`)
                return
            }
            
            if (diffusionList.length === 0) {
                try {
                    await sock.sendMessage(from, { text: "❌ La lista de difusión está vacía." })
                } catch (err) {
                    console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
                }
                console.log(`❌ Comando 'iniciar difusion' falló: lista vacía`)
                return
            }

            if (isDiffusionActive) {
                try {
                    await sock.sendMessage(from, { text: "❌ Ya hay una difusión en curso. Cancela la actual con 'cancelar difusion' antes de iniciar una nueva." })
                } catch (err) {
                    console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
                }
                console.log(`❌ Comando 'iniciar difusion' falló: difusión ya activa`)
                return
            }

            isDiffusionActive = true
            try {
                await sock.sendMessage(from, { text: "✅ Iniciando difusión... (respetando horario laboral: lunes a viernes, 9 a 21 hs, con throttling). Usa 'cancelar difusion' para detenerla." })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            console.log(`✅ Comando 'iniciar difusion' iniciado exitosamente`)
            commandExecuted = true
            
            for (let i = 0; i < diffusionList.length && isDiffusionActive; i++) {
                const to = diffusionList[i]
                const now = new Date()
                const hour = now.getHours()
                const day = now.getDay()
                
                if (day >= 1 && day <= 5 && hour >= 9 && hour < 21) {
                    try {
                        await sock.sendMessage(to, { text: message })
                        console.log(`✅ Mensaje enviado a ${to}`)
                        await new Promise(resolve => setTimeout(resolve, 5000))
                    } catch (err) {
                        console.error(`❌ Error enviando a ${to}:`, err)
                    }
                } else {
                    console.log(`⏰ Skip ${to}: fuera del horario laboral (lunes a viernes, 9 a 21 hs)`)
                }
            }
            
            if (isDiffusionActive) {
                isDiffusionActive = false
                try {
                    await sock.sendMessage(from, { text: "✅ Difusión completada." })
                } catch (err) {
                    console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
                }
                console.log(`✅ Difusión completada exitosamente`)
            } else {
                console.log(`✅ Difusión cancelada durante ejecución`)
            }
        } else if (lowerBody === "cancelar difusion") {
            const wasActive = isDiffusionActive
            isDiffusionActive = false
            diffusionList = []
            const response = wasActive
                ? "✅ Difusión en curso cancelada y lista de difusión limpiada."
                : "✅ Lista de difusión cancelada y limpiada."
            try {
                await sock.sendMessage(from, { text: response })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            commandExecuted = true
            console.log(`✅ Comando 'cancelar difusion' ejecutado exitosamente (activa: ${wasActive})`)
        } else if (lowerBody === "guardar difusion") {
            saveDiffusion()
            try {
                await sock.sendMessage(from, { text: "✅ Estado de difusión guardado en archivo." })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            commandExecuted = true
            console.log(`✅ Comando 'guardar difusion' ejecutado exitosamente`)
        } else if (lowerBody === "cargar difusion") {
            await loadDiffusion()
            try {
                await sock.sendMessage(from, { text: "✅ Estado de difusión cargado desde archivo." })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            commandExecuted = true
            console.log(`✅ Comando 'cargar difusion' ejecutado exitosamente`)
        } else if (lowerBody === "ping") {
            try {
                await sock.sendMessage(from, { text: "pong 🏓" })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            commandExecuted = true
            console.log(`✅ Comando 'ping' ejecutado exitosamente`)
        } else {
            try {
                await sock.sendMessage(from, { text: "❓ Comando no reconocido. Usa: ping, agregar difusion, listar difusion, iniciar difusion, cancelar difusion, guardar difusion, cargar difusion" })
            } catch (err) {
                console.error(`❌ Error enviando respuesta al admin ${from}:`, err)
            }
            console.log(`❓ Comando no reconocido: ${body}`)
        }

        if (commandExecuted) {
            console.log(`✅ Bot respondió al comando del admin`)
        }
    })
}

start()