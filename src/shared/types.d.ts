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
export interface AttributedQuote {
    speaker: string;
    role: string;
    text: string;
    confidence: 'high' | 'medium' | 'low';
}
export interface Insights {
    topics: string[];
    people: string[];
    keyFacts: string[];
    searchQueries: string[];
    summary: string;
    quotes?: AttributedQuote[];
}
export interface SearchResult {
    title: string;
    snippet: string;
    url: string;
    content: string;
    scrapedTitle?: string;
    scrapedImage?: string;
}
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
export interface DuplicateCheckResult {
    isDuplicate: boolean;
    matchedPublication: Publication | null;
    similarity: number;
}
export interface NewsGenerationOptions {
    transcription: string;
    tone?: string;
    structure?: string;
    webContext?: string;
    insights?: string;
    context?: string;
}
export interface WebhookSettings {
    webhook_pipeline: string;
    webhook_nuevo_boton: string;
    webhook_viejo_boton: string;
    webhook_tercer_boton: string;
}
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
export declare const BUILTIN_NODES: PipelineNodeDefinition[];
export declare const DEFAULT_NODE_ORDER: string[];
//# sourceMappingURL=types.d.ts.map