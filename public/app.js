let transcriptionData = sessionStorage.getItem("transcriptionData") || "";

document
  .getElementById("imageForm")
  .addEventListener("submit", function (event) {
    event.preventDefault();

    const imageInput = document.getElementById("imageInput");
    const titleInput = document.getElementById("titleInput");
    const descriptionInput = document.getElementById("descriptionInput");

    const formData = new FormData();
    formData.append("image", imageInput.files[0]);
    formData.append("title", titleInput.value);
    formData.append("description", descriptionInput.value);

    // Enviar la imagen al servidor para que sea procesada
    fetch("/generate", {
      method: "POST",
      body: formData,
    })
      .then((response) => response.json())
      .then((data) => {
        const imageUrl = data.imageUrl;
        const finalImagePath = data.finalImagePath;

        // Mostrar la imagen generada en el frontend
        document.getElementById("generatedImage").src = imageUrl;
        document.getElementById("generatedImage").style.display = "block";

        // Habilitar el enlace de descarga para la imagen generada
        document.getElementById("downloadLink").href = imageUrl;
        document.getElementById("downloadLink").style.display = "block";

        // Mostrar el botón de enviar webhook
        const sendWebhookBtn = document.getElementById("sendWebhookBtn");
        sendWebhookBtn.style.display = "block";

        // Limpiar los event listeners anteriores
        const newSendWebhookBtn = sendWebhookBtn.cloneNode(true);
        sendWebhookBtn.parentNode.replaceChild(
          newSendWebhookBtn,
          sendWebhookBtn
        );

        // Enviar los datos al webhook cuando el usuario haga clic en el botón
        newSendWebhookBtn.addEventListener("click", function () {
          const webhookData = {
            title: titleInput.value,
            description: descriptionInput.value,
            imageUrl: imageUrl,
            finalImagePath: finalImagePath,
          };

          // Enviar los datos del webhook
          fetch("/sendWebhook", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(webhookData),
          })
            .then((response) => response.json())
            .then((data) => {
              console.log("Webhook enviado con éxito", data);
            })
            .catch((error) => {
              console.error("Error al enviar el webhook:", error);
            });
        });
      })
      .catch((error) => {
        console.error("Error al procesar la imagen:", error);
        alert("Error al procesar la imagen: " + error.message);
      });
  });

// Generar la placa desde la URL
document.getElementById("urlForm").addEventListener("submit", function (event) {
  event.preventDefault();

  const urlInput = document.getElementById("urlInput");
  const url = urlInput.value;

  fetch("/generate-from-url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  })
    .then((response) => response.json())
    .then((data) => {
      const imageUrl = data.imageUrl;
      const title = data.title;
      const content = data.content;
      const finalImagePath = data.finalImagePath;

      // Mostrar la imagen generada en el frontend
      document.getElementById("generatedImageUrl").src = imageUrl;
      document.getElementById("generatedImageUrl").style.display = "block";

      // Habilitar el enlace de descarga para la imagen generada
      document.getElementById("downloadLink2").href = imageUrl;
      document.getElementById("downloadLink2").style.display = "block";

      // Mostrar el botón de enviar webhook (Nuevo Botón)
      const sendWebhookBtnNuevoBoton = document.getElementById(
        "sendWebhookBtnNuevoBoton"
      );
      sendWebhookBtnNuevoBoton.style.display = "block";

      // Limpiar los event listeners anteriores
      const newSendWebhookBtnNuevoBoton =
        sendWebhookBtnNuevoBoton.cloneNode(true);
      sendWebhookBtnNuevoBoton.parentNode.replaceChild(
        newSendWebhookBtnNuevoBoton,
        sendWebhookBtnNuevoBoton
      );

      // Listener para enviar el webhook al hacer clic en el botón "Crear Nota"
      newSendWebhookBtnNuevoBoton.addEventListener("click", function () {
        const webhookData = {
          title: title,
          content: content,
          imageUrl: imageUrl,
          finalImagePath: finalImagePath,
        };

        // Enviar los datos del webhook
        fetch("/sendWebhookNuevoBoton", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(webhookData),
        })
          .then((response) => response.json())
          .then((data) => {
            console.log("Webhook enviado con éxito (nuevo botón)", data);
          })
          .catch((error) => {
            console.error("Error al enviar el webhook (nuevo botón):", error);
          });
      });
    })
    .catch((error) => {
      console.error("Error al generar la placa:", error);
      alert("Error al generar la placa: " + error.message);
    });
});

// 1. Obtener referencias a los botones y al textarea
const startCaptureBtn = document.getElementById("startCaptureBtn");
const stopCaptureBtn = document.getElementById("stopCaptureBtn");
const transcriptionArea = document.getElementById("transcriptionArea");
const generateNewsBtn = document.getElementById("generateNewsBtn"); // Obtener referencia al botón "Generar Noticia"

// 2. Estado para rastrear si la captura está en curso
let isCapturing = false;

// 3. Función para habilitar/deshabilitar los botones
function updateButtonStates() {
  startCaptureBtn.disabled = isCapturing;
  stopCaptureBtn.disabled = !isCapturing;
}

// 4.  Función para agregar una nueva transcripción al textarea
function addTranscriptionToArea(transcription) {
  transcriptionArea.value += `${transcription.timestamp} - ${transcription.text}\n`;
  transcriptionArea.scrollTop = transcriptionArea.scrollHeight;
}

// 5.  Listener para el botón "Iniciar Captura"
startCaptureBtn.addEventListener("click", () => {
  if (!isCapturing) {
    fetch("/start-capture", { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          console.log("Captura iniciada:", data.message);
          isCapturing = true;
          updateButtonStates(); // Actualizar el estado de los botones
        } else {
          console.error("Error al iniciar captura:", data.message);
          alert("Error al iniciar captura: " + data.message);
        }
      })
      .catch((error) => {
        console.error("Error al iniciar captura:", error);
        alert("Error al iniciar captura: " + error);
      });
  } else {
    alert("La captura ya está en curso.");
  }
});

// 6.  Listener para el botón "Detener Captura"
stopCaptureBtn.addEventListener("click", () => {
  if (isCapturing) {
    fetch("/stop-capture", { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          console.log("Captura detenida:", data.message);
          isCapturing = false;
          updateButtonStates(); // Actualizar el estado de los botones

          // Mostrar el contenedor para crear la nota
          document.getElementById("createNewsContainer").style.display =
            "block";
        } else {
          console.error("Error al detener captura:", data.message);
          alert("Error al detener captura: " + data.message);
        }
      })
      .catch((error) => {
        console.error("Error al detener captura:", error);
        alert("Error al detener captura: " + error);
      });
  } else {
    alert("La captura no está en curso.");
  }
});

// 7. Listener para el botón "Crear Nota Periodística"
document.getElementById("generateNewsBtn").addEventListener("click", () => {
  const contextInput = document.getElementById("contextInput").value;
  const transcriptionText = transcriptionArea.value;

  fetch("/generateNewsCopy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      context: contextInput,
      transcription: transcriptionText,
    }),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      // Mostrar la nota generada en el textarea
      const generatedNewsCopy = data.generatedCopy;
      const newsOutputArea = document.getElementById("generatedNewsCopy");
      newsOutputArea.value = generatedNewsCopy;

      // Mostrar el área de la nota generada
      document.getElementById("newsOutput").style.display = "block";
    })
    .catch((error) => {
      console.error("Error al generar la nota:", error);
      alert("Error al generar la nota: " + error.message);
    });
});

// 7. Inicializar el estado de los botones al cargar la página
updateButtonStates(); // Establecer el estado inicial de los botones

// 8. Conectar al servidor usando Socket.IO (ESTO DEBE MANTENERSE)
const socket = io();
console.log("Conexión WebSocket establecida");

// 9. Solicitar la transcripción inicial al servidor (ESTO DEBE MANTENERSE)
fetch("/get-transcriptions")
  .then((response) => response.json())
  .then((data) => {
    if (data && data.transcriptions) {
      data.transcriptions.forEach((transcription) => {
        addTranscriptionToArea(transcription);
      });
    }
  })
  .catch((error) =>
    console.error("Error al cargar las transcripciones:", error)
  );

// 10. Escuchar actualizaciones de transcripción en tiempo real (ESTO DEBE MANTENERSE)
socket.on("receive-transcription-update", function (newTranscription) {
  console.log("Recibido nueva transcripción:", newTranscription); // Verifica que la transcripción llegue correctamente
  addTranscriptionToArea(newTranscription);
});

// Click en el botón "Generar Noticia"
document
  .getElementById("generateNewsBtn")
  .addEventListener("click", function () {
    document.getElementById("newsForm").style.display = "block";
  });

document
  .getElementById("generateNewsCopyBtn")
  .addEventListener("click", function () {
    const contextInput = document.getElementById("contextInput").value;
    const transcriptionArea = document.getElementById("transcriptionArea");
    const actualTranscriptionData = transcriptionArea.value;
    // Enviar los datos al backend para generar el copy
    fetch("/generateNewsCopy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        context: contextInput,
        transcription: actualTranscriptionData,
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        // Mostrar la nota generada en el textarea
        document.getElementById("generatedNewsCopy").value = data.generatedCopy;
        document.getElementById("newsOutput").style.display = "block";
      })
      .catch((error) => {
        console.error("Error al generar la nota:", error);
        alert("Error al generar la nota: " + error.message);
      });
  });
