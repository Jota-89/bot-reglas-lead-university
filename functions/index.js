const {onCall} = require("firebase-functions/v2/https");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const admin = require("firebase-admin");
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

admin.initializeApp();

// Inicializar Gemini con API key directa
const genAI = new GoogleGenerativeAI("AIzaSyCr4iFChsKJmvN92nNHq1xX97XFDy-cuxk");

// Variable para almacenar el contenido del PDF
let reglamentoContent = null;

// Función para leer y procesar el PDF
async function loadReglamento() {
  if (reglamentoContent) return reglamentoContent;
  
  try {
    console.log('=== DEBUG: Iniciando carga del PDF ===');
    
    // Ruta al PDF
    const pdfPath = path.join(__dirname, 'Reglamento.pdf');
    console.log('Ruta del PDF:', pdfPath);
    
    // Verificar si el archivo existe
    if (!fs.existsSync(pdfPath)) {
      console.error('ERROR: El archivo PDF no existe en:', pdfPath);
      // Listar archivos en la carpeta
      const files = fs.readdirSync(__dirname);
      console.log('Archivos en functions:', files);
      return "Error: No se encontró el archivo PDF del reglamento.";
    }
    
    console.log('Archivo PDF encontrado, leyendo...');
    const dataBuffer = fs.readFileSync(pdfPath);
    console.log('Buffer leído, tamaño:', dataBuffer.length, 'bytes');
    
    console.log('Parseando PDF...');
    const data = await pdfParse(dataBuffer);
    console.log('PDF parseado exitosamente, texto extraído:', data.text.length, 'caracteres');
    console.log('Primeros 200 caracteres:', data.text.substring(0, 200));
    
    reglamentoContent = data.text;
    return reglamentoContent;
  } catch (error) {
    console.error('Error completo cargando PDF:', error);
    return "Error al cargar el reglamento académico: " + error.message;
  }
}

// Función principal para consultar el reglamento
exports.consultarReglamento = onCall(async (request) => {
  try {
    console.log('=== NUEVA CONSULTA ===');
    const {pregunta} = request.data;
    console.log('Pregunta recibida:', pregunta);
    
    if (!pregunta) {
      return {success: false, error: 'Pregunta requerida'};
    }

    // Cargar contenido del PDF
    console.log('Cargando reglamento...');
    const reglamento = await loadReglamento();
    console.log('Reglamento cargado, primeros 100 caracteres:', reglamento.substring(0, 100));
    
    // Construir el prompt para Gemini
    const prompt = `
Eres un asistente especializado en el reglamento académico de Lead University.

REGLAMENTO ACADÉMICO:
${reglamento}

PREGUNTA DEL ESTUDIANTE: ${pregunta}

INSTRUCCIONES:
1. Responde SOLO basándote en el reglamento académico proporcionado
2. Si la información no está en el reglamento, indica claramente que no tienes esa información
3. Proporciona respuestas claras y específicas
4. Incluye referencias a artículos o secciones específicas cuando sea posible
5. Si es relevante, proporciona ejemplos prácticos
6. Mantén un tono amigable pero profesional

RESPUESTA:
`;

    console.log('Enviando prompt a Gemini...');
    
    // Generar respuesta con Gemini
    const model = genAI.getGenerativeModel({model: "gemini-1.5-flash"});
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const respuesta = response.text();

    console.log('Respuesta de Gemini recibida, longitud:', respuesta.length);

    return {
      success: true,
      respuesta: respuesta,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Error en consultarReglamento:', error);
    return {
      success: false,
      error: 'Error procesando la consulta: ' + error.message
    };
  }
});

// Función auxiliar para obtener información específica
exports.getBecasInfo = onCall(async (request) => {
  try {
    console.log('=== CONSULTA DE BECAS ===');
    const reglamento = await loadReglamento();
    
    const prompt = `
Basándote en este reglamento académico de Lead University:
${reglamento}

Extrae toda la información relacionada con BECAS y presenta un resumen organizado con:
1. Tipos de becas disponibles
2. Requisitos para aplicar
3. Porcentajes de descuento
4. Proceso de solicitud
5. Fechas importantes

Si no hay información sobre becas, indica claramente que no se encontró esta información en el reglamento.
`;

    const model = genAI.getGenerativeModel({model: "gemini-1.5-flash"});
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    return {
      success: true,
      respuesta: response.text()
    };
    
  } catch (error) {
    console.error('Error obteniendo info de becas:', error);
    return {success: false, error: error.message};
  }
});