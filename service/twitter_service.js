import fs from "fs";
import { TwitterApi } from "twitter-api-v2";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Credenciales de Twitter (Asegúrate de protegerlas con variables de entorno)
const appKey = process.env.TWITTER_APP_KEY;
const appSecret = process.env.TWITTER_APP_SECRET;
const accessToken = process.env.TWITTER_ACCESS_TOKEN;
const accessSecret = process.env.TWITTER_ACCESS_SECRET;

// Inicializa el cliente de Twitter
const client = new TwitterApi({
  appKey,
  appSecret,
  accessToken,
  accessSecret,
});

const facebookLink = "https://facebook.com/radiounofsa";

// Rutas de los logs de Twitter
const tweetsLogPathViejoBoton = "./tweets_log_viejo.json";
const tweetsLogPathNuevoBoton = "./tweets_log_nuevo.json";

// Función genérica para leer logs de tweets
function readTweetsLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const data = fs.readFileSync(logPath, "utf8");
  return JSON.parse(data);
}

// Función genérica para guardar logs de tweets
function saveTweetLog(logPath, tweetText) {
  const tweetsLog = readTweetsLog(logPath);
  tweetsLog.push(tweetText);
  fs.writeFileSync(logPath, JSON.stringify(tweetsLog, null, 2));
}

// Función para descargar la imagen y guardarla localmente
async function downloadImage(imageUrl) {
  try {
    const response = await axios({
      method: "GET",
      url: imageUrl,
      responseType: "arraybuffer",
    });

    const filename = `temp_image_${Date.now()}.jpg`;
    const imagePath = path.join(__dirname, "temp", filename);
    fs.writeFileSync(imagePath, Buffer.from(response.data, "binary"));
    return imagePath;
  } catch (error) {
    console.error("Error al descargar la imagen:", error);
    throw error;
  }
}

// Función para subir la imagen a Twitter y obtener su ID
async function uploadImageToTwitter(imagePath) {
  try {
    const mediaId = await client.v1.uploadMedia(imagePath);
    return mediaId;
  } catch (error) {
    console.error("Error al subir la imagen a Twitter:", error);
    throw error;
  }
}

// Función genérica para publicar un tweet con imagen
async function postTweetWithImage(logPath, title, imageUrl) {
  try {
    const tweetsLog = readTweetsLog(logPath);
    const tweetText = `${title}\n${facebookLink}`; // Usar el título y el enlace de Facebook

    if (tweetsLog.includes(tweetText)) {
      console.log("El tweet ya ha sido publicado anteriormente.");
      return;
    }

    // Descargar la imagen
    const imagePath = await downloadImage(imageUrl);

    // Subir la imagen a Twitter
    const mediaId = await uploadImageToTwitter(imagePath);

    // Publicar el tweet con la imagen
    await client.v2.tweet(tweetText, { media: { media_ids: [mediaId] } });
    console.log("Tweet publicado con éxito!");
    saveTweetLog(logPath, tweetText);

    // Eliminar la imagen local después de subirla
    fs.unlinkSync(imagePath);
  } catch (error) {
    console.error("Error al publicar el tweet:", error);
  }
}

// Funciones específicas para cada botón
async function postTweetViejoBoton(title, imageUrl) {
  await postTweetWithImage(tweetsLogPathViejoBoton, title, imageUrl);
}

async function postTweetNuevoBoton(title, imageUrl) {
  await postTweetWithImage(tweetsLogPathNuevoBoton, title, imageUrl);
}

export { postTweetViejoBoton, postTweetNuevoBoton };
