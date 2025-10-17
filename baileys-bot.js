import { EventEmitter } from 'events';
import pino from 'pino';
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    Browsers
} from '@whiskeysockets/baileys';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import fs from 'fs';
import qrcode from 'qrcode-terminal';

class BaileysBot extends EventEmitter {
    constructor(args = {}) {
        super();
        this.vendor = null;
        this.globalArgs = { 
            name: 'chatbot-rrhh', 
            debug: false,
            ...args 
        };
        this.NAME_DIR_SESSION = `${this.globalArgs.name}_sessions`;
        this.reconnectCount = 0;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.processedMessages = new Set();
        
        // Lista de administradores
        this.ADMINS = [
            "206119809089706@lid", // Lucas (+542613628979)
            "238138756755627@lid",  // Cris (+542612519570)
            "5492613628979@s.whatsapp.net",
            "5492612519570@s.whatsapp.net"
        ];
        
        // Configuración de difusión
        this.DIFFUSION_FILE = "diffusion.json";
        this.diffusionList = [];
        this.isDiffusionActive = false;
        
        this.initBailey();
    }

    async initBailey() {
        try {
            const logger = pino({ level: this.globalArgs.debug ? 'debug' : 'silent' });
            const { state, saveCreds } = await useMultiFileAuthState(this.NAME_DIR_SESSION);
            const { version, isLatest } = await fetchLatestBaileysVersion();

            console.log(`🚀 Usando WA v${version.join('.')}, isLatest: ${isLatest}`);

            this.sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                browser: Browsers.macOS('Desktop'),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                markOnlineOnConnect: false
            });

            this.sock.ev.on('connection.update', this.handleConnectionUpdate);
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('messages.upsert', this.handleMessages);
            
            // Manejo de errores para evitar crashes
            this.sock.ev.on('messaging-history.set', () => {
                console.log('📚 Historial de mensajes sincronizado');
            });
            
            process.on('uncaughtException', (error) => {
                console.error('🚨 Error no capturado:', error.message);
            });
            
            process.on('unhandledRejection', (reason, promise) => {
                console.error('🚨 Promesa rechazada no manejada:', reason);
            });

            await this.loadDiffusion();

        } catch (error) {
            console.error('❌ Error al inicializar:', error);
            this.emit('auth_failure', error);
        }
    }

    handleConnectionUpdate = async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 Nuevo QR Code - Escanea con WhatsApp:');
            qrcode.generate(qr, { small: true });
            this.emit('qr', qr);
        }

        if (connection === 'connecting') {
            console.log('🔄 Conectando...');
        }

        if (connection === 'open') {
            console.log('✅ Bot conectado exitosamente!');
            this.reconnectCount = 0;
            this.vendor = this.sock;
            this.emit('ready', true);
            
            // Notificar a admins
            for (const admin of this.ADMINS) {
                try {
                    await this.sendText(admin, '✅ Bot iniciado y conectado con el número de la empresa');
                    console.log(`✅ Mensaje de inicio enviado al admin ${admin}`);
                } catch (err) {
                    console.error(`❌ Error enviando mensaje de inicio al admin ${admin}:`, err.message);
                }
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Conexión cerrada - Status: ${statusCode}`);
            console.log(`   Error: ${lastDisconnect?.error?.message || 'Sin error específico'}`);
            console.log(`   Intentos de reconexión: ${this.reconnectCount}/${this.MAX_RECONNECT_ATTEMPTS}`);

            // Limpiar cache de mensajes al desconectar
            this.processedMessages.clear();

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                                  statusCode !== DisconnectReason.multideviceMismatch &&
                                  this.reconnectCount < this.MAX_RECONNECT_ATTEMPTS;

            if (shouldReconnect) {
                this.reconnectCount++;
                const delay = Math.min(5000 * this.reconnectCount, 30000);
                console.log(`⏳ Reintentando en ${delay/1000} segundos...`);
                setTimeout(() => {
                    console.log('🔄 Iniciando reconexión...');
                    this.initBailey();
                }, delay);
            } else if (this.reconnectCount >= this.MAX_RECONNECT_ATTEMPTS) {
                console.log('🛑 Máximo número de reconexiones alcanzado. Limpiando sesión...');
                this.clearSessionAndRestart();
            } else {
                console.log('🛑 Sesión cerrada manualmente o deslogueado');
                this.emit('auth_failure', new Error('Sesión cerrada'));
            }
        }
    }

    handleMessages = async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const messageCtx of messages) {
            if (!messageCtx?.message || messageCtx.key.fromMe) continue;

            const from = messageCtx.key.remoteJid;
            const body = messageCtx.message?.conversation || 
                        messageCtx.message?.extendedTextMessage?.text || 
                        messageCtx.message?.imageMessage?.caption || 
                        '';

            // Evitar duplicados usando el ID del mensaje
            const messageId = messageCtx.key.id;
            if (this.processedMessages?.has(messageId)) {
                console.log(`🔄 Mensaje duplicado ignorado: ${messageId}`);
                continue;
            }

            // Marcar mensaje como procesado
            if (!this.processedMessages) this.processedMessages = new Set();
            this.processedMessages.add(messageId);

            console.log(`\n📨 MENSAJE RECIBIDO:`);
            console.log(`   📱 De: ${from}`);
            console.log(`   💬 Contenido: "${body}"`);
            console.log(`   🆔 ID: ${messageId}`);
            console.log(`   🔍 Es admin: ${this.ADMINS.includes(from) ? '✅ SÍ' : '❌ NO'}`);

            if (!this.ADMINS.includes(from)) {
                console.log(`🚫 Mensaje ignorado (no es admin)\n`);
                continue;
            }

            console.log(`📩 Procesando comando de admin...`);
            
            const payload = {
                key: messageCtx.key,
                message: messageCtx.message,
                from,
                body,
                type: 'text'
            };

            this.emit('message', payload);
            await this.processCommand(from, body);
            
            // Limpiar mensajes antiguos del cache (mantener solo los últimos 100)
            if (this.processedMessages.size > 100) {
                const oldMessages = Array.from(this.processedMessages).slice(0, 50);
                oldMessages.forEach(id => this.processedMessages.delete(id));
            }
        }
    }

    async processCommand(from, body) {
        const lowerBody = body.toLowerCase().trim();
        let commandExecuted = false;

        try {
            if (lowerBody.startsWith("agregar difusion")) {
                await this.handleAddDiffusion(from, body);
                commandExecuted = true;
            } else if (lowerBody === "listar difusion") {
                await this.handleListDiffusion(from);
                commandExecuted = true;
            } else if (lowerBody.startsWith("iniciar difusion")) {
                await this.handleStartDiffusion(from, body);
                commandExecuted = true;
            } else if (lowerBody === "cancelar difusion") {
                await this.handleCancelDiffusion(from);
                commandExecuted = true;
            } else if (lowerBody === "guardar difusion") {
                await this.handleSaveDiffusion(from);
                commandExecuted = true;
            } else if (lowerBody === "cargar difusion") {
                await this.handleLoadDiffusion(from);
                commandExecuted = true;
            } else if (lowerBody === "ping") {
                await this.sendText(from, "🏓 pong! Bot funcionando correctamente");
                commandExecuted = true;
            } else if (lowerBody === "debug" || lowerBody === "mi id") {
                const debugInfo = `🔍 Debug Info:
• Tu ID: ${from}
• Es admin: ${this.ADMINS.includes(from) ? 'SÍ' : 'NO'}
• Lista admins: ${this.ADMINS.join(', ')}
• Lista difusión: ${this.diffusionList.length} números`;
                await this.sendText(from, debugInfo);
                commandExecuted = true;
            } else {
                await this.sendText(from, "❓ Comando no reconocido. Usa: ping, debug, agregar difusion, listar difusion, iniciar difusion, cancelar difusion, guardar difusion, cargar difusion");
            }

            if (commandExecuted) {
                console.log(`✅ Comando procesado exitosamente\n`);
            }
        } catch (error) {
            console.error(`❌ Error procesando comando:`, error);
            await this.sendText(from, `❌ Error procesando comando: ${error.message}`);
        }
    }

    // Métodos de difusión (simplificados por ahora)
    async handleAddDiffusion(from, body) {
        const content = body.slice("agregar difusion".length).trim();
        const numbers = content.split("\n").map(n => n.trim()).filter(n => n);
        
        if (numbers.length === 0) {
            await this.sendText(from, "❌ Debes proporcionar números después de 'agregar difusion'.");
            return;
        }

        const validNumbers = [];
        const invalidNumbers = [];
        const duplicateNumbers = [];
        
        for (const num of numbers) {
            const originalNum = num;
            let cleanNum = num.replace(/[\s-+().]/g, '');
            
            // Normalizar números argentinos
            if (cleanNum.startsWith('54') && !cleanNum.startsWith('549')) {
                cleanNum = `549${cleanNum.slice(2)}`;
            }
            
            // Si es un número de área argentino sin el prefijo internacional
            if (cleanNum.match(/^(?:11|220|221|223|230|236|237|239|249|260|261|262|263|264|265|266|280|290|291|292|294|295|296|297|298|299|332|341|342|343|344|345|346|347|348|349|351|352|353|354|357|358|362|364|365|370|371|372|373|374|375|376|377|378|379|380|381|382|383|384|385|386|387|388|389)\d{7}$/)) {
                cleanNum = `549${cleanNum}`;
            }
            
            // Validar formato final
            if (cleanNum.match(/^\d{10,15}$/)) {
                const whatsappId = `${cleanNum}@s.whatsapp.net`;
                
                // Verificar si ya existe en la lista
                if (this.diffusionList.includes(whatsappId)) {
                    duplicateNumbers.push(originalNum);
                } else {
                    validNumbers.push(whatsappId);
                }
            } else {
                invalidNumbers.push(originalNum);
            }
        }

        // Agregar solo los números válidos y no duplicados
        this.diffusionList.push(...validNumbers);
        
        // Crear mensaje de respuesta detallado
        let responseMessage = '';
        
        if (validNumbers.length > 0) {
            responseMessage += `✅ Agregados ${validNumbers.length} números válidos a la lista de difusión.\n`;
        }
        
        if (duplicateNumbers.length > 0) {
            responseMessage += `\n🔄 Números duplicados (ya estaban en la lista): ${duplicateNumbers.length}\n`;
            responseMessage += duplicateNumbers.map(num => `• ${num}`).join('\n');
        }
        
        if (invalidNumbers.length > 0) {
            responseMessage += `\n❌ Números inválidos (no agregados): ${invalidNumbers.length}\n`;
            responseMessage += invalidNumbers.map(num => `• ${num}`).join('\n');
        }
        
        if (responseMessage === '') {
            responseMessage = "❌ No se pudo agregar ningún número.";
        }
        
        responseMessage += `\n\n📊 Total en lista de difusión: ${this.diffusionList.length} números`;
        
        await this.sendText(from, responseMessage);
    }

    async handleListDiffusion(from) {
        const listText = this.diffusionList.length > 0 ? 
            `📋 Lista de difusión (${this.diffusionList.length} números):\n${this.diffusionList.map(id => id.split('@')[0]).join('\n')}` : 
            "📋 La lista de difusión está vacía.";
        await this.sendText(from, listText);
    }

    async handleStartDiffusion(from, body) {
        const message = body.slice("iniciar difusion".length).trim();
        if (!message) {
            await this.sendText(from, "❌ Debes proporcionar un mensaje después de 'iniciar difusion'.");
            return;
        }

        if (this.diffusionList.length === 0) {
            await this.sendText(from, "❌ La lista de difusión está vacía.");
            return;
        }

        if (this.isDiffusionActive) {
            await this.sendText(from, "❌ Ya hay una difusión en curso.");
            return;
        }

        this.isDiffusionActive = true;
        await this.sendText(from, `✅ Iniciando difusión a ${this.diffusionList.length} números...`);

        // Enviar mensajes con delay
        for (let i = 0; i < this.diffusionList.length && this.isDiffusionActive; i++) {
            const to = this.diffusionList[i];
            try {
                await this.sendText(to, message);
                console.log(`✅ Mensaje enviado a ${to}`);
                await new Promise(resolve => setTimeout(resolve, 3000)); // 3 segundos entre mensajes
            } catch (err) {
                console.error(`❌ Error enviando a ${to}:`, err.message);
            }
        }

        if (this.isDiffusionActive) {
            this.isDiffusionActive = false;
            await this.sendText(from, "✅ Difusión completada.");
        }
    }

    async handleCancelDiffusion(from) {
        const wasActive = this.isDiffusionActive;
        this.isDiffusionActive = false;
        this.diffusionList = [];
        const response = wasActive
            ? "✅ Difusión cancelada y lista limpiada."
            : "✅ Lista de difusión limpiada.";
        await this.sendText(from, response);
    }

    async handleSaveDiffusion(from) {
        this.saveDiffusion();
        await this.sendText(from, "✅ Lista de difusión guardada.");
    }

    async handleLoadDiffusion(from) {
        await this.loadDiffusion();
        await this.sendText(from, "✅ Lista de difusión cargada.");
    }

    // Métodos de archivo
    async loadDiffusion() {
        if (existsSync(this.DIFFUSION_FILE)) {
            try {
                this.diffusionList = JSON.parse(fs.readFileSync(this.DIFFUSION_FILE, "utf8"));
                console.log(`✅ Lista de difusión cargada: ${this.diffusionList.length} números`);
            } catch (err) {
                console.error("❌ Error cargando difusión:", err);
            }
        }
    }

    saveDiffusion() {
        fs.writeFileSync(this.DIFFUSION_FILE, JSON.stringify(this.diffusionList, null, 2));
        console.log("✅ Lista de difusión guardada");
    }

    // Métodos de envío
    async sendText(number, message) {
        if (!this.vendor) {
            throw new Error('Bot no está conectado');
        }
        return this.vendor.sendMessage(number, { text: message });
    }

    // Métodos de utilidad
    clearSessionAndRestart() {
        const PATH_BASE = join(process.cwd(), this.NAME_DIR_SESSION);
        rmSync(PATH_BASE, { recursive: true, force: true });
        console.log("🗑️ Sesión limpiada. Reiniciando...");
        this.initBailey();
    }

    getInstance() {
        return this.vendor;
    }
}

export default BaileysBot;