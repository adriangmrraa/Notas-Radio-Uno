// Branding
export type FontFamilyId = 'bebas_kai' | 'oswald' | 'roboto_condensed' | 'montserrat' | 'lato' | 'playfair';
export type TemplateId = 'dark_gradient' | 'solid_bar' | 'minimal' | 'split' | 'vignette';
export type PlatformType = 'youtube' | 'facebook' | 'kick' | 'twitch' | 'radio_stream' | 'website' | 'other';
export type ConductorRole = 'conductor' | 'columnista' | 'productor' | 'invitado' | 'other';

export interface BrandingConfig {
  logoBuffer: Buffer | null;
  platformName: string;
  fontFamily: FontFamilyId;
  templateId: TemplateId;
}

export interface BrandingResponse {
  platformName: string | null;
  logoUrl: string | null;
  fontFamily: FontFamilyId;
  templateId: TemplateId;
  hasLogo: boolean;
}

export interface Program {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  schedule: string | null;
  isActive: boolean;
  urls: ProgramUrl[];
  createdAt: string;
}

export interface ProgramUrl {
  id: string;
  programId: string;
  type: PlatformType;
  url: string;
  label: string | null;
}

export interface Conductor {
  id: string;
  tenantId: string;
  programId?: string | null;
  name: string;
  role: ConductorRole | null;
  bio: string | null;
  isActive: boolean;
  photos: ConductorPhoto[];
  createdAt: string;
}

export interface ConductorPhoto {
  id: string;
  conductorId: string;
  mimeType: string;
  isPrimary: boolean;
  createdAt: string;
}

// Pipeline
export interface PipelineConfig {
  url: string;
  tone: string;
  structure: string;
  imageModel: string;
  segmentDuration: number;
  autoPublish: boolean;
  programId?: string;
}

export interface PipelineStatus {
  running: boolean;
  currentStep: string;
  config: PipelineConfig;
  chunksTranscribed: number;
  totalMinutes: number;
  transcriptionLength: number;
  publishedTopics: string[];
  totalPublished: number;
  publishedNotes: PublishedNote[];
}

export interface PublishedNote {
  title: string;
  content: string;
  flyerPath: string;
  topic: string;
  timestamp: string;
}

export interface TranscriptionChunk {
  text: string;
  timestamp: string;
  chunkNumber: number;
  diarizedText?: string;
  speakerCount?: number;
  provider?: string;
}

// Topic Analysis
export interface TopicSegment {
  topic: string;
  summary: string;
  status: 'completed' | 'ongoing';
  newsworthy: boolean;
  suggestedNotes: number;
  confidence: 'high' | 'medium' | 'low';
  startText: string;
  endText: string;
}

export interface TopicAnalysisResult {
  segments: TopicSegment[];
  ongoingTopic: string | null;
  recommendation: 'wait' | 'publish';
  reason: string;
  hasCompletedTopics: boolean;
  completedSegments: TopicSegment[];
  newPendingConfirmation: string[];
  retakenTopics: string[];
}

// Quote Attribution
export interface AttributedQuote {
  speaker: string;
  role: string;
  text: string;
  confidence: 'high' | 'medium' | 'low';
}

// Insights
export interface Insights {
  topics: string[];
  people: string[];
  keyFacts: string[];
  searchQueries: string[];
  summary: string;
  quotes?: AttributedQuote[];
}

// Search
export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  content: string;
  scrapedTitle?: string;
  scrapedImage?: string;
}

// Content Multiplier — variantes multiplataforma
export interface ContentVariants {
  twitterThread: string[];      // array de tweets (cada uno ≤280 chars)
  instagramCarousel: string[];  // array de textos por slide
  linkedinPost: string;
  youtubeDescription: string;
  newsletterBlurb: string;
}

// Review / Editorial Copilot
export type PublicationStatus = 'pending_review' | 'approved' | 'published' | 'rejected';

export interface EditHistoryEntry {
  action: 'created' | 'text_edit' | 'image_edit' | 'approved' | 'rejected' | 'published';
  prompt?: string;
  timestamp: string;
  by: string; // 'pipeline' | 'user' | userId
}

export interface ReviewPublication {
  id: string;
  tenantId: string;
  title: string | null;
  content: string | null;
  imagePath: string | null;
  imageUrl: string | null;
  status: PublicationStatus;
  editHistory: EditHistoryEntry[];
  quotes: any[] | null;
  quoteFlyerPaths: string[];
  contentVariants?: ContentVariants | null;
  createdAt: string;
}

// Publications
export interface Publication {
  id?: number;
  title: string;
  content: string | null;
  image_path: string | null;
  image_url: string | null;
  source: string;
  publish_results: any;
  created_at?: string;
}

export interface Transcription {
  id?: number;
  text: string;
  audio_file: string | null;
  source: string;
  duration_seconds: number | null;
  created_at?: string;
}

// Meta
export interface MetaAsset {
  id: number;
  asset_type: string;
  external_id: string;
  name: string;
  metadata: Record<string, any>;
  is_active: number;
}

export interface MetaPublishResults {
  facebook: any[];
  instagram: any[];
  errors: any[];
}

// AI
export interface ChatCompletionOptions {
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface ChatCompletionResult {
  text: string;
  provider: "deepseek" | "gemini" | "openai";
}

export interface ScrapedArticle {
  title: string;
  content: string;
  imageUrl: string;
  url: string;
}

// Deduplication
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedPublication: Publication | null;
  similarity: number;
}

// News Generation
export interface NewsGenerationOptions {
  transcription: string;
  tone?: string;
  structure?: string;
  webContext?: string;
  insights?: string;
  context?: string;
}

// Webhook settings
export interface WebhookSettings {
  webhook_pipeline: string;
  webhook_nuevo_boton: string;
  webhook_viejo_boton: string;
  webhook_tercer_boton: string;
}

// Pipeline Editor & Custom Agents
export interface CustomAgent {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  position: number;
  after_step: string;
  is_enabled: boolean;
  ai_provider: 'auto' | 'deepseek' | 'gemini';
  temperature: number;
  max_tokens: number;
  tools: string[];
  template_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PipelineNodeDefinition {
  id: string;
  type: 'builtin' | 'agent';
  name: string;
  description: string;
  icon: string;
  inputType: string;
  outputType: string;
  configurable: boolean;
  agent?: CustomAgent;
}

export interface PipelineConfigData {
  id: string;
  name: string;
  node_order: string[];
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  defaultAfterStep: string;
  systemPrompt: string;
  tools: string[];
  temperature: number;
  icon: string;
}

export interface AgentInput {
  nodeId: string;
  previousNodeId: string;
  data: Record<string, unknown>;
}

export interface AgentOutput {
  nodeId: string;
  data: Record<string, unknown>;
  executionTimeMs: number;
  provider: string;
}

export const BUILTIN_NODES: PipelineNodeDefinition[] = [
  { id: 'capture', type: 'builtin', name: 'Captura de Audio', description: 'yt-dlp + ffmpeg', icon: '🎤', inputType: 'stream_url', outputType: 'audio_file', configurable: false },
  { id: 'transcribe', type: 'builtin', name: 'Transcripción', description: 'Whisper (Python)', icon: '🧠', inputType: 'audio_file', outputType: 'text', configurable: false },
  { id: 'analyze', type: 'builtin', name: 'Análisis de Temas', description: 'Segmentación con IA', icon: '🔍', inputType: 'text', outputType: 'segments', configurable: false },
  { id: 'insights', type: 'builtin', name: 'Extracción de Insights', description: 'Personas, datos, queries', icon: '💡', inputType: 'text', outputType: 'insights', configurable: false },
  { id: 'search', type: 'builtin', name: 'Investigación Web', description: 'Gemini Grounded Search', icon: '🌐', inputType: 'insights', outputType: 'search_results', configurable: false },
  { id: 'generate_news', type: 'builtin', name: 'Generación de Nota', description: 'DeepSeek/Gemini', icon: '✍️', inputType: 'search_results', outputType: 'news_content', configurable: false },
  { id: 'generate_title', type: 'builtin', name: 'Generación de Título', description: 'IA periodística', icon: '📰', inputType: 'news_content', outputType: 'titled_content', configurable: false },
  { id: 'generate_flyer', type: 'builtin', name: 'Creación de Placa', description: 'Nano Banana 2 + overlay', icon: '🖼️', inputType: 'titled_content', outputType: 'flyer', configurable: false },
  { id: 'publish', type: 'builtin', name: 'Publicación', description: 'Multi-plataforma', icon: '📤', inputType: 'flyer', outputType: 'published', configurable: false },
];

export const DEFAULT_NODE_ORDER = ['capture', 'transcribe', 'analyze', 'insights', 'search', 'generate_news', 'generate_title', 'generate_flyer', 'publish'];

// Diarization
export interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface DiarizedTranscription {
  text: string;
  diarizedText: string;
  speakerCount: number;
  utterances: Utterance[];
  provider: 'assemblyai' | 'whisper';
}

// Guest Dossier
export interface GuestDossier {
  id: string;
  guestId: string;
  guestName: string;
  scheduledDate: string;
  status: 'generating' | 'ready' | 'error';
  content: DossierContent | null;
  generatedAt: string | null;
  createdAt: string;
}

export interface DossierContent {
  summary: string;
  bio: string;
  recentActivity: string[];
  controversies: string[];
  suggestedQuestions: string[];
  keyFacts: string[];
  relatedTopics: string[];
  talkingPoints: string[];
}

// Clips — Auto-Clips Verticales con Subtítulos
export interface ClipCandidate {
  startMs: number;
  endMs: number;
  hookText: string;
  reason: string;
}

export interface Clip {
  id: string;
  tenantId: string;
  publicationId: string | null;
  programId: string | null;
  title: string;
  hookText: string;
  videoPath: string | null;
  duration: number;
  status: 'generating' | 'ready' | 'pending_review' | 'published' | 'error';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// Live Alert — Detección de momentos relevantes en transmisiones en vivo
export interface LiveAlert {
  type: 'breaking_news' | 'strong_statement' | 'key_data' | 'emotional_peak' | 'keyword';
  severity: 'high' | 'medium' | 'low';
  title: string;
  excerpt: string;
  context: string;
  speaker?: string;
  matchedKeyword?: string;
  timestamp: string;
}


// Guest
export interface Guest {
  id: string;
  tenantId: string;
  programId: string;
  name: string;
  role: string;
  bio: string | null;
  scheduledDate: string;
  scheduledTimeStart: string | null;
  scheduledTimeEnd: string | null;
  isActive: boolean;
  photos: GuestPhoto[];
  createdAt: string;
}

export interface GuestPhoto {
  id: string;
  guestId: string;
  mimeType: string;
  isPrimary: boolean;
  createdAt: string;
}
