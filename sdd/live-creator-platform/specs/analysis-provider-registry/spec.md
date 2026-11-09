# Spec: analysis-provider-registry - Contratos y seleccion de proveedores de analisis

## Proposito

Cubrir PE-01 con una frontera explicita entre el pipeline y proveedores de transcripcion, analisis multimodal e imagen. Evita que la eleccion de Gemini/AssemblyAI quede dispersa o que un fallback cambie comportamiento sin observabilidad.

## Comportamiento observable

### Requirement: Contrato por capacidad

El sistema MUST exponer interfaces tipadas por capacidad (`transcription`, `video_analysis`, `image_generation`) y un registry que resuelva un proveedor habilitado por tenant/proceso; los adaptadores devuelven un resultado normalizado con proveedor, modelo, costo, latencia y error clasificado.

#### Scenario: Analisis visual con proveedor configurado
- GIVEN un tenant habilitado para Gemini y un segmento de transmision
- WHEN el pipeline solicita `video_analysis`
- THEN usa el adaptador permitido, guarda proveedor/modelo/costo y devuelve momentos, temas y citas normalizados

### Requirement: Fallback explicito y observable

El registry MUST aplicar fallback solo desde una cadena declarada y permitida por plan/feature flag. Si no existe fallback, MUST fallar con error reintentable o terminal clasificado; nunca puede cambiar proveedor silenciosamente.

#### Scenario: Proveedor primario caido
- GIVEN Gemini no disponible y un fallback habilitado
- WHEN se ejecuta el analisis
- THEN el job registra la causa, usa el fallback y emite metrica; sin fallback queda reintentable sin crear contenido parcial duplicado

### Requirement: Configuracion segura

Las claves y la configuracion de proveedor MUST resolverse desde secretos de plataforma/tenant cifrados, no desde payloads ni prompts. El registry MUST permitir kill-switch por capability.

## Datos involucrados

- Configuracion declarativa de providers/modelos, `tenant_features`, `ai_cost_records`, `jobs_queue` y referencias de proveedor/modelo en los resultados del pipeline.

## Trazabilidad

PE-01, PE-02, PF-08, D-2. Implementado por T-63; lo consumen T-30 y T-67.
