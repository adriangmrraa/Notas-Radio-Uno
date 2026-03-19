// Pipeline
export interface PipelineConfig {
  url: string;
  tone: string;
  structure: string;
  imageModel: string;
  segmentDuration: number;
  autoPublish: boolean;
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

// Insights
export interface Insights {
  topics: string[];
  people: string[];
  keyFacts: string[];
  searchQueries: string[];
  summary: string;
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
  provider: "deepseek" | "gemini";
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
