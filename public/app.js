// =============================================
// META CONNECTION (Facebook + Instagram)
// =============================================

const socket = io();
console.log("Conexión WebSocket establecida");

// Variables de configuración Meta (inyectadas desde el servidor o configuradas aquí)
const META_APP_ID = window.META_APP_ID || "";
const META_CONFIG_ID = window.META_CONFIG_ID || "";

let fbSdkReady = false;

// Cargar Facebook SDK (inspirado en useFacebookSdk de Platform ROI)
function loadFacebookSdk() {
  return new Promise((resolve) => {
    if (window.FB) {
      fbSdkReady = true;
      resolve(true);
      return;
    }

    // Timeout de 5 segundos
    const timeout = setTimeout(() => {
      console.warn("[Meta] Facebook SDK timeout - no se pudo cargar");
      resolve(false);
    }, 5000);

    window.fbAsyncInit = function () {
      clearTimeout(timeout);
      FB.init({
        appId: META_APP_ID,
        cookie: true,
        xfbml: false,
        version: "v22.0",
      });
      fbSdkReady = true;
      console.log("[Meta] Facebook SDK inicializado");
      resolve(true);
    };

    // Cargar script
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/es_LA/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.head.appendChild(script);
  });
}

// Verificar estado de conexión Meta
async function checkMetaStatus() {
  try {
    const response = await fetch("/meta/status");
    const status = await response.json();
    updateMetaUI(status);
    return status;
  } catch (error) {
    console.error("[Meta] Error verificando estado:", error);
    updateMetaUI({ connected: false });
  }
}

// Actualizar UI según estado de conexión Meta
function updateMetaUI(status) {
  const statusDot = document.getElementById("metaStatusDot");
  const statusText = document.getElementById("metaStatusText");
  const assetsContainer = document.getElementById("metaAssetsContainer");
  const connectContainer = document.getElementById("metaConnectContainer");
  const pagesList = document.getElementById("metaPagesList");
  const igList = document.getElementById("metaIgList");

  if (status.connected) {
    statusDot.className = "status-dot active";
    statusText.textContent = "Conectado a Meta";
    assetsContainer.style.display = "block";
    connectContainer.style.display = "none";

    // Mostrar pages conectadas
    pagesList.innerHTML = "";
    if (status.pages && status.pages.length > 0) {
      const header = document.createElement("h4");
      header.textContent = "Facebook Pages:";
      pagesList.appendChild(header);
      status.pages.forEach((page) => {
        const el = document.createElement("div");
        el.className = "meta-asset-item";
        el.innerHTML = `<span class="meta-asset-icon">📘</span> ${page.name}`;
        pagesList.appendChild(el);
      });
    }

    // Mostrar IG accounts conectadas
    igList.innerHTML = "";
    if (status.instagramAccounts && status.instagramAccounts.length > 0) {
      const header = document.createElement("h4");
      header.textContent = "Instagram:";
      igList.appendChild(header);
      status.instagramAccounts.forEach((ig) => {
        const el = document.createElement("div");
        el.className = "meta-asset-item";
        el.innerHTML = `<span class="meta-asset-icon">📸</span> ${ig.name || ig.username}${ig.username ? " (@" + ig.username + ")" : ""}`;
        igList.appendChild(el);
      });
    }

    // Mostrar expiración del token si existe
    if (status.expiresAt) {
      const expiresDate = new Date(status.expiresAt);
      const daysLeft = Math.ceil((expiresDate - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft > 0 && daysLeft < 10) {
        statusText.textContent = `Conectado a Meta (token expira en ${daysLeft} días)`;
        statusDot.className = "status-dot warning";
      }
    }
  } else {
    statusDot.className = "status-dot";
    statusText.textContent = "No conectado";
    assetsContainer.style.display = "none";
    connectContainer.style.display = "block";
  }
}

// Handler para el botón "Conectar con Meta"
function handleMetaConnect() {
  if (!fbSdkReady) {
    alert("El SDK de Facebook no se pudo cargar. Verificá tu conexión a internet y que META_APP_ID esté configurado.");
    return;
  }

  // Abrir popup de Meta Login (igual que Platform ROI MetaSettings.tsx)
  const loginOptions = {
    scope: "pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,pages_show_list",
    return_scopes: true,
  };

  // Si hay config_id, usar Facebook Login for Business
  if (META_CONFIG_ID) {
    loginOptions.config_id = META_CONFIG_ID;
    loginOptions.response_type = "code";
  }

  FB.login(function (response) {
    if (response.authResponse) {
      const { accessToken, code } = response.authResponse;
      connectMetaWithBackend({ accessToken, code });
    } else {
      console.log("[Meta] Usuario canceló el login");
    }
  }, loginOptions);
}

// Enviar token al backend para intercambio y almacenamiento
async function connectMetaWithBackend({ accessToken, code }) {
  const connectBtn = document.getElementById("metaConnectBtn");
  const originalText = connectBtn.innerHTML;
  connectBtn.disabled = true;
  connectBtn.innerHTML = "Conectando...";

  try {
    const response = await fetch("/meta/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken,
        code,
        redirectUri: window.location.origin,
      }),
    });

    const data = await response.json();

    if (data.success) {
      updateMetaUI({
        connected: true,
        pages: data.assets.pages,
        instagramAccounts: data.assets.instagramAccounts,
      });

      // Mostrar advertencia de permisos faltantes si hay
      if (data.permissions && data.permissions.missing && data.permissions.missing.length > 0) {
        const warningEl = document.getElementById("metaPermissionsWarning");
        const listEl = document.getElementById("metaMissingPermissions");
        listEl.innerHTML = data.permissions.missing
          .map((p) => `<li>${p}</li>`)
          .join("");
        warningEl.style.display = "block";
      }

      alert(`Meta conectado con éxito!\n\nPages: ${data.assets.pages.length}\nInstagram: ${data.assets.instagramAccounts.length}`);
    } else {
      alert("Error al conectar: " + (data.error || "Error desconocido"));
    }
  } catch (error) {
    console.error("[Meta] Error conectando:", error);
    alert("Error de conexión: " + error.message);
  } finally {
    connectBtn.disabled = false;
    connectBtn.innerHTML = originalText;
  }
}

// Handler para desconectar
async function handleMetaDisconnect() {
  if (!confirm("¿Seguro que querés desconectar Meta? Las publicaciones ya no se enviarán directamente a Facebook e Instagram.")) {
    return;
  }

  try {
    const response = await fetch("/meta/disconnect", { method: "POST" });
    const data = await response.json();
    if (data.success) {
      updateMetaUI({ connected: false });
      document.getElementById("metaPermissionsWarning").style.display = "none";
    }
  } catch (error) {
    console.error("[Meta] Error desconectando:", error);
    alert("Error al desconectar: " + error.message);
  }
}

// Inicializar Meta
(async function initMeta() {
  // Cargar config del servidor
  try {
    const configResponse = await fetch("/meta/config");
    if (configResponse.ok) {
      const config = await configResponse.json();
      window.META_APP_ID = config.appId || "";
      window.META_CONFIG_ID = config.configId || "";
    }
  } catch (_) {}

  // Cargar SDK si hay app ID
  if (window.META_APP_ID) {
    await loadFacebookSdk();
  }

  // Verificar estado de conexión
  await checkMetaStatus();

  // Event listeners
  const connectBtn = document.getElementById("metaConnectBtn");
  if (connectBtn) connectBtn.addEventListener("click", handleMetaConnect);

  const disconnectBtn = document.getElementById("metaDisconnectBtn");
  if (disconnectBtn) disconnectBtn.addEventListener("click", handleMetaDisconnect);
})();

// =============================================
// PIPELINE AUTÓNOMO
// =============================================

// Pipeline elements
const startPipelineBtn = document.getElementById("startPipelineBtn");
const stopPipelineBtn = document.getElementById("stopPipelineBtn");
const pipelineStatus = document.getElementById("pipelineStatus");
const pipelineLog = document.getElementById("pipelineLog");
const pipelineTranscription = document.getElementById("pipelineTranscription");
const pipelineStatusDot = document.getElementById("pipelineStatusDot");
const pipelineStatusText = document.getElementById("pipelineStatusText");
const publishedNotesList = document.getElementById("publishedNotesList");

function addLogEntry(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  pipelineLog.appendChild(entry);
  pipelineLog.scrollTop = pipelineLog.scrollHeight;
}

function updateStepUI(activeStep) {
  const steps = [
    "capturing",
    "analyzing",
    "searching",
    "generating",
    "creating_flyer",
    "publishing",
  ];
  steps.forEach((step) => {
    const el = document.getElementById(`step-${step}`);
    if (el) {
      el.classList.remove("active", "completed");
      const idx = steps.indexOf(step);
      const activeIdx = steps.indexOf(activeStep);
      if (step === activeStep) {
        el.classList.add("active");
      } else if (activeIdx > idx) {
        el.classList.add("completed");
      }
    }
  });
}

function addPublishedNote(title, timestamp) {
  const container = document.getElementById("publishedNotesContainer");
  container.style.display = "block";
  const noteEl = document.createElement("div");
  noteEl.className = "published-note";
  noteEl.innerHTML = `<strong>${title}</strong><br><small>${new Date(timestamp).toLocaleString()}</small>`;
  publishedNotesList.prepend(noteEl);
}

// Image model hint toggle
const imageModelSelect = document.getElementById("pipelineImageModel");
const imageModelHint = document.getElementById("imageModelHint");
const modelHints = {
  gemini: "Requiere GEMINI_API_KEY en el servidor",
  grok: "Requiere XAI_API_KEY en el servidor",
};
imageModelSelect.addEventListener("change", () => {
  imageModelHint.textContent = modelHints[imageModelSelect.value] || "";
});

// Iniciar Pipeline
startPipelineBtn.addEventListener("click", () => {
  const url = document.getElementById("pipelineUrl").value;
  if (!url) {
    alert("Ingresá una URL de transmisión.");
    return;
  }

  const config = {
    url,
    tone: document.getElementById("pipelineTone").value,
    structure: document.getElementById("pipelineStructure").value,
    imageModel: document.getElementById("pipelineImageModel").value,
    publishInterval: parseInt(
      document.getElementById("pipelineInterval").value,
    ),
    segmentDuration: parseInt(
      document.getElementById("pipelineSegment").value,
    ),
    autoPublish: document.getElementById("pipelineAutoPublish").checked,
  };

  fetch("/pipeline/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        startPipelineBtn.disabled = true;
        stopPipelineBtn.disabled = false;
        pipelineStatus.style.display = "block";
        pipelineStatusDot.className = "status-dot active";
        pipelineStatusText.textContent = "En ejecución";
        pipelineLog.innerHTML = "";
        pipelineTranscription.value = "";
        addLogEntry("Pipeline iniciado - " + url, "success");
      } else {
        alert(data.error || "Error al iniciar el pipeline.");
      }
    })
    .catch((error) => {
      alert("Error: " + error.message);
    });
});

// Detener Pipeline
stopPipelineBtn.addEventListener("click", () => {
  fetch("/pipeline/stop", { method: "POST" })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        startPipelineBtn.disabled = false;
        stopPipelineBtn.disabled = true;
        pipelineStatusDot.className = "status-dot stopped";
        pipelineStatusText.textContent = "Detenido";
        addLogEntry(
          `Pipeline detenido. Total publicadas: ${data.stats.totalPublished}`,
          "warning",
        );
        updateStepUI("");
      }
    })
    .catch((error) => {
      alert("Error: " + error.message);
    });
});

// Escuchar eventos del pipeline en tiempo real
socket.on("pipeline-update", function (data) {
  console.log("Pipeline update:", data);

  switch (data.event) {
    case "step":
      addLogEntry(data.message, "info");
      updateStepUI(data.step);
      break;

    case "transcription":
      pipelineTranscription.value += `[${new Date(data.timestamp).toLocaleTimeString()}] ${data.text}\n\n`;
      pipelineTranscription.scrollTop = pipelineTranscription.scrollHeight;
      addLogEntry(
        `Transcripción recibida (buffer: ${data.bufferSize} segmentos)`,
        "info",
      );
      break;

    case "insights":
      addLogEntry(
        `Insights: ${data.insights.summary || "Sin resumen"}`,
        "info",
      );
      break;

    case "search":
      addLogEntry(
        `Búsqueda web: ${data.resultsCount} resultados encontrados`,
        "info",
      );
      break;

    case "note":
      addLogEntry(`Nota generada: "${data.title}"`, "success");
      break;

    case "flyer_bg":
      if (data.source === "ai_generating") {
        addLogEntry(
          `Generando fondo con ${data.model === "grok" ? "Grok Image" : "Google Imagen"}...`,
          "info",
        );
      } else if (data.source === "gemini_imagen") {
        addLogEntry("Fondo generado con Google Imagen", "success");
      } else if (data.source === "grok_image") {
        addLogEntry("Fondo generado con Grok Image (xAI)", "success");
      } else if (data.source === "web") {
        addLogEntry("Fondo obtenido de artículo web", "info");
      } else if (data.source === "placeholder") {
        addLogEntry("Usando fondo placeholder (sin API de imagen configurada)", "warning");
      }
      break;

    case "flyer":
      addLogEntry("Placa informativa creada", "success");
      break;

    case "published":
      addLogEntry(
        `PUBLICADO: "${data.title}" (Total: ${data.totalPublished})`,
        "success",
      );
      addPublishedNote(data.title, data.timestamp);
      break;

    case "error":
      addLogEntry(`ERROR en ${data.step}: ${data.message}`, "error");
      break;

    case "publish_warnings":
      data.warnings.forEach((w) => addLogEntry(`Advertencia: ${w}`, "warning"));
      break;

    case "stopped":
      pipelineStatusDot.className = "status-dot stopped";
      pipelineStatusText.textContent = "Detenido";
      startPipelineBtn.disabled = false;
      stopPipelineBtn.disabled = true;
      break;
  }
});

// Polling estado cada 30 segundos
setInterval(() => {
  fetch("/pipeline/status")
    .then((res) => res.json())
    .then((data) => {
      if (data.running) {
        pipelineStatusDot.className = "status-dot active";
        pipelineStatusText.textContent = `En ejecución - ${data.currentStep}`;
      }
    })
    .catch(() => {});
}, 30000);

// =============================================
// FUNCIONALIDAD ORIGINAL (sin cambios)
// =============================================

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

    fetch("/generate", {
      method: "POST",
      body: formData,
    })
      .then((response) => response.json())
      .then((data) => {
        const imageUrl = data.imageUrl;
        const finalImagePath = data.finalImagePath;

        document.getElementById("generatedImage").src = imageUrl;
        document.getElementById("generatedImage").style.display = "block";
        document.getElementById("downloadLink").href = imageUrl;
        document.getElementById("downloadLink").style.display = "block";

        const sendWebhookBtn = document.getElementById("sendWebhookBtn");
        sendWebhookBtn.style.display = "block";

        const newSendWebhookBtn = sendWebhookBtn.cloneNode(true);
        sendWebhookBtn.parentNode.replaceChild(
          newSendWebhookBtn,
          sendWebhookBtn,
        );

        newSendWebhookBtn.addEventListener("click", function () {
          fetch("/sendWebhook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: titleInput.value,
              description: descriptionInput.value,
              imageUrl: imageUrl,
              finalImagePath: finalImagePath,
            }),
          })
            .then((response) => response.json())
            .then((data) => console.log("Webhook enviado con éxito", data))
            .catch((error) =>
              console.error("Error al enviar el webhook:", error),
            );
        });
      })
      .catch((error) => {
        console.error("Error al procesar la imagen:", error);
        alert("Error al procesar la imagen: " + error.message);
      });
  });

document
  .getElementById("urlForm")
  .addEventListener("submit", function (event) {
    event.preventDefault();

    const urlInput = document.getElementById("urlInput");
    const url = urlInput.value;

    fetch("/generate-from-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
      .then((response) => response.json())
      .then((data) => {
        const imageUrl = data.imageUrl;
        const title = data.title;
        const content = data.content;
        const finalImagePath = data.finalImagePath;

        document.getElementById("generatedImageUrl").src = imageUrl;
        document.getElementById("generatedImageUrl").style.display = "block";
        document.getElementById("downloadLink2").href = imageUrl;
        document.getElementById("downloadLink2").style.display = "block";

        const sendWebhookBtnNuevoBoton = document.getElementById(
          "sendWebhookBtnNuevoBoton",
        );
        sendWebhookBtnNuevoBoton.style.display = "block";

        const newBtn = sendWebhookBtnNuevoBoton.cloneNode(true);
        sendWebhookBtnNuevoBoton.parentNode.replaceChild(
          newBtn,
          sendWebhookBtnNuevoBoton,
        );

        newBtn.addEventListener("click", function () {
          fetch("/sendWebhookNuevoBoton", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, content, imageUrl, finalImagePath }),
          })
            .then((response) => response.json())
            .then((data) =>
              console.log("Webhook enviado con éxito (nuevo botón)", data),
            )
            .catch((error) =>
              console.error("Error al enviar el webhook (nuevo botón):", error),
            );
        });
      })
      .catch((error) => {
        console.error("Error al generar la placa:", error);
        alert("Error al generar la placa: " + error.message);
      });
  });

// Audio capture controls
const startCaptureBtn = document.getElementById("startCaptureBtn");
const stopCaptureBtn = document.getElementById("stopCaptureBtn");
const transcriptionArea = document.getElementById("transcriptionArea");

let isCapturing = false;

function updateButtonStates() {
  startCaptureBtn.disabled = isCapturing;
  stopCaptureBtn.disabled = !isCapturing;
}

function addTranscriptionToArea(transcription) {
  transcriptionArea.value += `${transcription.timestamp} - ${transcription.text}\n`;
  transcriptionArea.scrollTop = transcriptionArea.scrollHeight;
}

startCaptureBtn.addEventListener("click", () => {
  if (!isCapturing) {
    fetch("/start-capture", { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          isCapturing = true;
          updateButtonStates();
        } else {
          alert("Error al iniciar captura: " + data.message);
        }
      })
      .catch((error) => alert("Error al iniciar captura: " + error));
  }
});

stopCaptureBtn.addEventListener("click", () => {
  if (isCapturing) {
    fetch("/stop-capture", { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        if (data.success) {
          isCapturing = false;
          updateButtonStates();
          document.getElementById("createNewsContainer").style.display =
            "block";
        } else {
          alert("Error al detener captura: " + data.message);
        }
      })
      .catch((error) => alert("Error al detener captura: " + error));
  }
});

// News generation
document
  .getElementById("generateNewsBtn")
  .addEventListener("click", function () {
    document.getElementById("newsForm").style.display = "block";
  });

document
  .getElementById("generateNewsCopyBtn")
  .addEventListener("click", function () {
    const contextInput = document.getElementById("contextInput").value;
    const actualTranscriptionData = transcriptionArea.value;

    fetch("/generateNewsCopy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: contextInput,
        transcription: actualTranscriptionData,
      }),
    })
      .then((response) => response.json())
      .then((data) => {
        document.getElementById("generatedNewsCopy").value =
          data.generatedCopy;
        document.getElementById("newsOutput").style.display = "block";
      })
      .catch((error) => {
        console.error("Error al generar la nota:", error);
        alert("Error al generar la nota: " + error.message);
      });
  });

updateButtonStates();

// Cargar transcripciones existentes
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
    console.error("Error al cargar las transcripciones:", error),
  );

// Transcripción en tiempo real (sección original)
socket.on("receive-transcription-update", function (newTranscription) {
  addTranscriptionToArea(newTranscription);
});
