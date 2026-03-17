import subprocess
from datetime import datetime
import os
import whisper
import threading
import json
import signal
import sys

# URL de la transmisión de radio
stream_url = "https://streamingraddios.online/proxy/radiouno?mp=/stream"

# Duración de cada fragmento en segundos (2 minutos)
fragment_duration = 120

# Carga el modelo de Whisper
model = whisper.load_model("base")

# Directorio de salida para archivos de audio y transcripción
output_dir = "output"
os.makedirs(output_dir, exist_ok=True)

# Archivo JSON para guardar las transcripciones
transcription_file = os.path.join(output_dir, "transcripciones.json")

# Variable global para controlar la ejecución
running = True
ffmpeg_process = None

def initialize_json_file():
    """Inicializa el archivo JSON si no existe"""
    if not os.path.exists(transcription_file):
        # Si el archivo no existe, creamos la estructura inicial
        initial_data = {"transcriptions": []}
        with open(transcription_file, "w", encoding="utf-8") as f:
            json.dump(initial_data, f, ensure_ascii=False, indent=4)
        print("Archivo JSON de transcripciones inicializado.")

def transcribe_audio(file_path):
    """Transcribe audio a texto usando Whisper"""
    print(f"Iniciando transcripción del archivo: {file_path}")
    try:
        result = model.transcribe(file_path, fp16=False)
        text = result["text"]
        
        # Guardar la transcripción en el archivo JSON
        save_transcription_to_json(file_path, text)
    except Exception as e:
        print(f"Error durante la transcripción de {file_path}: {e}")

def save_transcription_to_json(file_path, transcription_text):
    """Guardar la transcripción en formato JSON"""
    timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    audio_filename = os.path.basename(file_path)

    # Leer el archivo JSON existente
    with open(transcription_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    # Agregar la nueva transcripción
    data["transcriptions"].append({
        "timestamp": timestamp,
        "audioFile": audio_filename,
        "text": transcription_text
    })

    # Guardar el archivo JSON actualizado
    with open(transcription_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"Transcripción guardada en JSON: {transcription_file}")

def capture_audio():
    """Captura audio de la radio en fragmentos de 2 minutos y lo transcribe"""
    global running, ffmpeg_process
    while running:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(output_dir, f"audio_{timestamp}.mp3")

        command = [
            "ffmpeg",
            "-i", stream_url,
            "-c:a", "libmp3lame",
            "-t", str(fragment_duration),
            output_file
        ]

        print(f"Iniciando captura de audio: {output_file}")
        
        ffmpeg_process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        
        for line in ffmpeg_process.stdout:
            print(line, end="")

        ffmpeg_process.wait()
        print(f"Archivo creado: {output_file}")

        # Transcribir en un hilo separado
        threading.Thread(target=transcribe_audio, args=(output_file,)).start()

def signal_handler(sig, frame):
    """Maneja la señal de interrupción (SIGINT)"""
    global running, ffmpeg_process
    print("\nSeñal de interrupción recibida. Deteniendo la captura...")
    running = False  # Detener el bucle principal

    if ffmpeg_process:
        print("Deteniendo ffmpeg...")
        ffmpeg_process.terminate()  # Envía una señal de terminación a ffmpeg
        ffmpeg_process.wait()  # Espera a que ffmpeg termine
        print("ffmpeg detenido.")

    sys.exit(0)  # Salir del programa

if __name__ == "__main__":
    try:
        # Inicializar el archivo JSON si no existe
        initialize_json_file()

        # Registrar el manejador de señales
        signal.signal(signal.SIGINT, signal_handler)

        # Iniciar la captura de audio
        capture_audio()
    except Exception as e:
        print(f"Error inesperado: {e}")
    finally:
        print("Script finalizado.")