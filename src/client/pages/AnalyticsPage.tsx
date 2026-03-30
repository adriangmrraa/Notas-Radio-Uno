import { useState, useEffect } from 'react';
import { BarChart3, TrendingUp, FileText, Mic, Cpu, Activity } from 'lucide-react';
import { useApi } from '../hooks/useApi';

interface Usage {
    pipelineHoursUsed: number;
    publicationsCount: number;
    transcriptionMinutes: number;
    aiTokensUsed: number;
    storageUsedMb: number;
}

export function AnalyticsPage() {
    const { fetchApi } = useApi();
    const [usage, setUsage] = useState<Usage | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchApi<Usage>('/billing/usage')
            .then(setUsage)
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
            </div>
        );
    }

    const metrics = [
        { label: 'Pipeline (horas)', value: usage ? Math.round(usage.pipelineHoursUsed * 10) / 10 : 0, icon: TrendingUp, color: 'cyan', gradient: 'from-cyan-500/15 to-cyan-600/5' },
        { label: 'Publicaciones', value: usage?.publicationsCount || 0, icon: FileText, color: 'emerald', gradient: 'from-emerald-500/15 to-emerald-600/5' },
        { label: 'Transcripcion (min)', value: usage ? Math.round(usage.transcriptionMinutes) : 0, icon: Mic, color: 'amber', gradient: 'from-amber-500/15 to-amber-600/5' },
        { label: 'Tokens IA', value: usage?.aiTokensUsed || 0, icon: Cpu, color: 'purple', gradient: 'from-purple-500/15 to-purple-600/5' },
    ];

    const colorMap: Record<string, string> = {
        cyan: 'text-cyan-400',
        emerald: 'text-emerald-400',
        amber: 'text-amber-400',
        purple: 'text-purple-400',
    };

    const bgMap: Record<string, string> = {
        cyan: 'bg-cyan-500/10 ring-cyan-500/20',
        emerald: 'bg-emerald-500/10 ring-emerald-500/20',
        amber: 'bg-amber-500/10 ring-amber-500/20',
        purple: 'bg-purple-500/10 ring-purple-500/20',
    };

    return (
        <div className="p-8 max-w-5xl mx-auto">
            <div className="flex items-center gap-3 mb-1">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-cyan-600/5 flex items-center justify-center ring-1 ring-cyan-500/20">
                    <BarChart3 className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold">Analytics</h1>
                    <p className="text-white/30 text-sm">Metricas de uso de este mes</p>
                </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8 stagger-children">
                {metrics.map(({ label, value, icon: Icon, color, gradient }) => (
                    <div key={label} className="glass-card group p-5 relative overflow-hidden">
                        {/* Decorative gradient orb */}
                        <div className={`absolute -top-8 -right-8 w-24 h-24 rounded-full bg-gradient-to-br ${gradient} blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />

                        <div className="relative">
                            <div className="flex items-center gap-2.5 mb-4">
                                <div className={`w-8 h-8 rounded-lg ${bgMap[color]} ring-1 flex items-center justify-center`}>
                                    <Icon className={`w-4 h-4 ${colorMap[color]}`} />
                                </div>
                                <span className="text-xs text-white/35 font-medium uppercase tracking-wider">{label}</span>
                            </div>
                            <p className="text-3xl font-bold tracking-tight">{typeof value === 'number' ? value.toLocaleString() : value}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="glass-card-static p-6 mt-8 animate-slide-up" style={{ animationDelay: '300ms' }}>
                <div className="flex items-center gap-3 mb-4">
                    <Activity className="w-5 h-5 text-white/30" />
                    <h2 className="text-lg font-semibold">Detalle por dia</h2>
                </div>
                <div className="flex flex-col items-center justify-center py-12">
                    <div className="w-16 h-16 rounded-2xl bg-white/[0.03] flex items-center justify-center mb-4 ring-1 ring-white/[0.06]">
                        <BarChart3 className="w-7 h-7 text-white/15" />
                    </div>
                    <p className="text-white/25 text-sm">Graficos detallados disponibles proximamente</p>
                </div>
            </div>
        </div>
    );
}
