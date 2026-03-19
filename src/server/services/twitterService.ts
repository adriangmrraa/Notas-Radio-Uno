import fs from "fs";
import { TwitterApi } from "twitter-api-v2";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { limiters } from "./rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure temp directory exists
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// Twitter credentials
const appKey = process.env.TWITTER_APP_KEY;
const appSecret = process.env.TWITTER_APP_SECRET;
const accessToken = process.env.TWITTER_ACCESS_TOKEN;
const accessSecret = process.env.TWITTER_ACCESS_SECRET;

// Initialize Twitter client only if credentials exist
let client: TwitterApi | null = null;
if (appKey && appSecret && accessToken && accessSecret) {
  client = new TwitterApi({
    appKey,
    appSecret,
    accessToken,
    accessSecret,
  });
} else {
  console.warn("[Twitter] Credenciales no configuradas. Publicación deshabilitada.");
}

const facebookLink = "https://facebook.com/radiounofsa";

// Tweet log paths
const tweetsLogPathViejoBoton = "./tweets_log_viejo.json";
const tweetsLogPathNuevoBoton = "./tweets_log_nuevo.json";

// Generic function to read tweet logs
function readTweetsLog(logPath: string): string[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const data = fs.readFileSync(logPath, "utf8");
  return JSON.parse(data) as string[];
}

// Generic function to save tweet logs
function saveTweetLog(logPath: string, tweetText: string): void {
  const tweetsLog = readTweetsLog(logPath);
  tweetsLog.push(tweetText);
  fs.writeFileSync(logPath, JSON.stringify(tweetsLog, null, 2));
}

// Download image and save locally
async function downloadImage(imageUrl: string): Promise<string> {
  try {
    const response = await axios({
      method: "GET",
      url: imageUrl,
      responseType: "arraybuffer",
    });

    const filename = `temp_image_${Date.now()}.jpg`;
    const imagePath = path.join(__dirname, "temp", filename);
    fs.writeFileSync(imagePath, Buffer.from(response.data as ArrayBuffer));
    return imagePath;
  } catch (error) {
    console.error("Error al descargar la imagen:", error);
    throw error;
  }
}

// Upload image to Twitter and get media ID
async function uploadImageToTwitter(imagePath: string): Promise<string> {
  if (!client) {
    throw new Error("Twitter client not initialized");
  }
  try {
    const mediaId = await client.v1.uploadMedia(imagePath);
    return mediaId;
  } catch (error) {
    console.error("Error al subir la imagen a Twitter:", error);
    throw error;
  }
}

// Generic function to post tweet with image
async function postTweetWithImage(logPath: string, title: string, imageUrl: string): Promise<void> {
  if (!client) {
    console.warn("[Twitter] No configurado, omitiendo publicación.");
    return;
  }

  try {
    await limiters.twitter.acquire();
    const tweetsLog = readTweetsLog(logPath);
    const tweetText = `${title}\n${facebookLink}`;

    if (tweetsLog.includes(tweetText)) {
      console.log("El tweet ya ha sido publicado anteriormente.");
      return;
    }

    // Download the image
    const imagePath = await downloadImage(imageUrl);

    // Upload image to Twitter
    const mediaId = await uploadImageToTwitter(imagePath);

    // Post tweet with image
    await client.v2.tweet(tweetText, { media: { media_ids: [mediaId] } });
    console.log("Tweet publicado con éxito!");
    saveTweetLog(logPath, tweetText);

    // Delete local image after upload
    fs.unlinkSync(imagePath);
  } catch (error) {
    console.error("Error al publicar el tweet:", error);
  }
}

// Specific functions for each button
async function postTweetViejoBoton(title: string, imageUrl: string): Promise<void> {
  await postTweetWithImage(tweetsLogPathViejoBoton, title, imageUrl);
}

async function postTweetNuevoBoton(title: string, imageUrl: string): Promise<void> {
  await postTweetWithImage(tweetsLogPathNuevoBoton, title, imageUrl);
}

export { postTweetViejoBoton, postTweetNuevoBoton };
