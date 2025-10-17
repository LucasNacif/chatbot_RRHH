import BaileysBot from './baileys-bot.js';

console.log('🚀 Iniciando Chatbot RRHH...');

const bot = new BaileysBot({
    name: 'chatbot-rrhh',
    debug: false
});

// Eventos del bot
bot.on('qr', (qr) => {
    console.log('📱 Escanea este QR con WhatsApp para conectar el bot');
});

bot.on('ready', () => {
    console.log('✅ Bot listo y operativo!');
    console.log('🎯 Los admins pueden enviar comandos ahora');
});

bot.on('auth_failure', (error) => {
    console.error('❌ Error de autenticación:', error);
});

bot.on('message', (message) => {
    // Este evento se emite para todos los mensajes procesados
    console.log(`📩 Mensaje procesado de ${message.from}`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error?.message || error);
    process.exit(1);
});

// Manejo de señales de terminación
process.on('SIGINT', () => {
    console.log('\n👋 Cerrando bot...');
    process.exit(0);
});

console.log('⏳ Configurando conexión...');