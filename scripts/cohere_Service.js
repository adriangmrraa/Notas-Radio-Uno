import { CohereClient } from "cohere-ai";
import * as dotenv from "dotenv"; // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
dotenv.config();

async function generateNewsCopy(context, transcription) {
  const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });
  try {
    const response = await cohere.generate({
      prompt: `A partir de la siguiente transcripción: ${transcription} y del contexto: ${context}, genera una nota periodística concisa y atractiva.`,
      model: "command-nightly",
      max_tokens: 500,
      temperature: 0.5,
      k: 0,
      stop_sequences: [],
      return_likelihoods: "NONE",
    });

    console.log(response.generations[0].text);
    return response.generations[0].text; // Accede al texto generado correctamente
  } catch (error) {
    console.error("Error al generar la nota con Cohere:", error);
    throw new Error("Error al generar la nota con Cohere: " + error.message);
  }
}

export { generateNewsCopy };
