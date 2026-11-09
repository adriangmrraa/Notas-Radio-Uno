# Flows — Flujos secuenciales críticos

## F1. Arranque programado de transmisión (scheduler → cuota → recorder)

```
engine.scheduler (loop 60s)
  │  SELECT * FROM scheduled_jobs WHERE is_active
  │  por cada job:
  │    nowTz = Intl.DateTimeFormat(job.timezone)  → day, HH:mm, jobLocalDate
  │    skip si daysOfWeek ∌ day | startTime ≠ HH:mm
  │    dedup: jobLocalDate(lastRunAt en job.timezone) == jobLocalDate → skip
  │    MAX_CONCURRENT_RECORDINGS alcanzado → queda para próximo ciclo
  ▼
quotaService.consume(job.tenantId, opId=`schedjob:{jobId}:{jobLocalDate}`)
  │  INSERT quota_operations ON CONFLICT (operation_id) DO NOTHING
  │    → si existe: devuelve resultado previo (retry-safe)
  │  UPDATE tenant_quotas SET transmissions_count = transmissions_count + n
  │    WHERE (tenant_id,period) AND transmissions_count < plan.max + extra
  │    RETURNING → sin fila = SIN CUOTA
  ├─ sin cuota → job_executions(status='skipped_quota') + notificación paywall + audit
  └─ con cuota ↓
transmissionService.create(source='live_capture', status='waiting',
    scheduledJobId, programId, streamUrl, operationId)
  + job_executions(status='running', transmission_id)
  + socket emit `transmission:waiting`
  ▼
engine.recorder (poll transmissions status='waiting')
  liveDetect loop (15 × 2min — ventana existente):
    detectLiveStream(streamUrl) → found
      resolved = yt-dlp -g  (una sola resolución)
      transmission.status='live', started_at=now → ANCLA wall-clock
      spawn ffmpeg -i resolved -c copy -f segment -segment_time 60 -strftime 1
      + audio tap actual (pipeline) en paralelo sobre la misma URL
    not found tras ventana → status='error'
      → quotaService.release(operationId) si captura efectiva < MIN_CAPTURE_MS
```

Reconciliación al boot del engine: `transmissions` en `live|waiting` con `last_heartbeat_at` viejo → según crudo existente: `processing` (finalizar) o `error`.

## F2. Pipeline en vivo (segmento → análisis → clip)

```
ffmpeg escribe seg_20250102T100000.mp4 ... en /data/media/{tenant}/{tx}/
watcher (poll/fs.watch) al cerrarse segmento N:
  INSERT recording_segments(seq=N, startMs=parse(strftime)-startedAt, endMs=startMs(N+1)|duración)
  emit `transmission:segment`
  ▼  en paralelo ───────────────────────────────────────────
frameSampler: ffmpeg -vf fps=1 seg_N.mp4 → frames/*.jpg
  POST face:8000/detect → faces[{bbox,embedding}]
  match pgvector: face_embeddings WHERE tenant_id ORDER BY embedding<=> LIMIT 1
    cosine < UMBRAL(0.5) → person_appearances(source='face', personId?, bbox)
audio tap (existe): chunk 120s → AssemblyAI → utterances{speaker,start+chunkOffset}
  attributionService.fuse():
    speaker_label × person_appearances en misma ventana → persona dominante
    → person_appearances(source='fusion', speaker_label, personId, confidence)
    ambiguo → candidata/baja confianza (nunca inventa)
pipelineService: topic segmentation (existente) → transmission_segments(kind='topic')
  moment detection → transmission_segments(kind='moment', score)
  SI count(clips del tx) < plan.maxClipsPerTransmission:
    jobs_queue.enqueue('render_clip', {transmissionId,startMs,endMs,momentId})
  mark manual (sala) → ventana [now-Ns, now] → mismo enqueue
  ▼
jobs worker 'render_clip':
  clipCutterService:
    segmentos que cubren [startMs,endMs] → ffmpeg concat/cut (-ss/-t)
    crop 9:16: centro = bbox ponderado del speaker dominante por tramo;
      split en cambio de speaker; fallback centrado
    ASS subs (utterances de la ventana, nombres resueltos, fuente tenant)
    remotion render LiveClipOverlay → overlay.webm (alpha)
    una pasada ffmpeg: crop→scale 1080x1920→subtitles→overlay→clip.mp4 + thumb
  assets.insert(type='clip', source='footage', status='ready'→'pending_review',
    source_window, transmission_id, asset_persons)
  emit `transmission:clip_ready`
Corrección: POST /api/live/:tx/correct {speakerLabel→personId}
  → appearances source='manual' hacia adelante + re-etiqueta emitidas → re-emit timeline
```

## F3. Aprobación → publish_job → Zernio

```
POST /api/assets/:id/approve   (requireRole owner|editor, requireFeature?)
  asset.status='approved' + audit('asset.approved')
  política='auto' (perfil efectivo + plan lo permite) → mismo path sin click
  destinos = social_connections activas (programa→tenant)
  por cada: publish_jobs(status='queued', dedup_key=asset:conn)
            + jobs_queue.enqueue('publish_job', {publishJobId})
  (sin conexiones → 'approved' + aviso "sin redes"; publica cuando exista)
  ▼
worker 'publish_job' → publishRouterService por connection.provider:
  'zernio' → zernioService.publish(conn.externalAccountId,
              {text: copy variante + mentions de persons.socials,
               media: upload binario (spike) o mediaSigner URL vía api})
    → external_post_id → status 'sending'
  'meta_legacy' → metaPublishService (portfolios/businessAssets existentes)
  'twitter_legacy' → twitterService  |  'webhook'/'drive' → publishService actual
  ▼
POST /api/webhooks/zernio (firma ZERNIO_WEBHOOK_SECRET, dedup por event id)
  post.published → publish_job 'published' + externalPostId
  post.failed    → publish_job 'failed' (reintento manual/backoff)
  account.connected    → upsert social_connections(provider='zernio', externalId→tenant)
  account.disconnected → is_active=false
rollup → asset.delivery_status{conn:estado} → 'published' cuando todas resuelven
```

## F4. Impersonación admin

```
POST /api/admin/tenants/:id/impersonate  (requirePlatformAdmin)
  admin_impersonations(expires_at=now+30m) + audit('admin.impersonation_started')
  JWT corto {userId:admin, activeTenantId:tenant, role:'owner',
             impersonatedBy:adminId, imp:true}
cliente → banner "viendo como {tenant}"; sockets re-join tenant:{id}
requests: requireAuth valida membresía? → NO requerida si impersonatedBy
          guard anti-destructive: imp → 403 en /billing, /team remove, delete tenant
          audit de cada acción con metadata.impersonatedBy
expira (claim) o POST /api/admin/impersonation/stop
  → ended_at + audit('admin.impersonation_ended') → vuelve a /admin
Impersonación durante impersonación / impersonar a otro admin → prohibido.
```

## F5. Ciclo de facturación con eventos

```
Stripe: POST /api/billing/webhook/stripe
  express.raw() ANTES de json() → constructEvent(rawBody, sig) → 400 si firma inválida
  dedup: billing_events.external_id = event.id (UNIQUE → 200 temprano si existe)
  subscriptionMachine.transition(sub.status, mapEvent(event.type), ctx)
    invoice.payment_failed: active→past_due + billing_event + enqueue 'dunning_cycle'
    invoice.paid (past_due): past_due→active 'reactivated' + period fields
    subscription.deleted: →canceled + cancel_reason
  transición inválida → rechazada + log (nunca mutación ad-hoc)
MP: POST /api/billing/webhook/mercadopago
  x-signature si MP_WEBHOOK_SECRET; SIEMPRE preApproval.get/payment.get re-fetch
  → confirma estado real → machine.transition (mismo camino)
dunning_cycle (jobs_queue diario):
  past_due → reintentar cobro provider + email (intento N/max)
  grace_ends_at vencido sin pago → 'suspended' (paywall, datos intactos)
Trial: register → 'trialing' (trial plan, maxTransmissions=2, 7d)
  consume 2.ª transmisión o trialEndsAt → 'expired' → paywall checkout
Soft-cancel: cancelAtPeriodEnd=true + motivo → activo hasta currentPeriodEnd
Add-on +5/+15: checkout único → quotaService.grant(tenant,n) kind='grant'
  (expira con el ciclo, no acumula)
Admin: change plan / extend trial / +N transmisiones / suspend → billing_event
  'admin_grant' + audit + efecto inmediato en cuota efectiva
```

## Reglas transversales recordatorias

- Transmisión activa NUNCA se corta por cuota; `maxDurationMinutes` sí la detiene suavemente (stop + procesa lo grabado + aviso).
- Fallo < `MIN_CAPTURE_MS` (default 5min) → release de la reserva, mismo operation_id.
- Toda escritura de audit es best-effort (nunca tira el request) y nunca persiste secretos.
- Webhook/job retries: idempotencia por `external_id`/`operation_id`/`dedup_key` — diseño, no convención.
