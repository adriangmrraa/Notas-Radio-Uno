import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding database...');

    await prisma.plan.createMany({
        data: [
            {
                name: 'trial',
                displayName: 'Trial Gratuito',
                description: 'Prueba la plataforma por 7 dias',
                priceUsd: 0,
                maxPipelineHoursPerMonth: 5,
                maxPublicationsPerMonth: 20,
                maxScheduledJobs: 1,
                maxCustomAgents: 2,
                maxTeamMembers: 1,
                maxConnectedPlatforms: 2,
                maxStorageGb: 2,
                features: {
                    webhook_integration: false,
                    custom_branding: false,
                    api_access: false,
                    priority_transcription: false,
                    advanced_analytics: false,
                    image_ai_generation: true,
                    multi_provider_ai: false,
                    scheduled_processing: false,
                },
                sortOrder: 0,
            },
            {
                name: 'starter',
                displayName: 'Starter',
                description: 'Para creadores y programas individuales',
                priceUsd: 29,
                priceUsdYearly: 290,
                maxPipelineHoursPerMonth: 30,
                maxPublicationsPerMonth: 100,
                maxScheduledJobs: 3,
                maxCustomAgents: 5,
                maxTeamMembers: 2,
                maxConnectedPlatforms: 4,
                maxStorageGb: 10,
                features: {
                    webhook_integration: true,
                    custom_branding: false,
                    api_access: false,
                    priority_transcription: false,
                    advanced_analytics: false,
                    image_ai_generation: true,
                    multi_provider_ai: false,
                    scheduled_processing: true,
                },
                sortOrder: 1,
            },
            {
                name: 'professional',
                displayName: 'Profesional',
                description: 'Para medios de comunicacion y equipos',
                priceUsd: 79,
                priceUsdYearly: 790,
                maxPipelineHoursPerMonth: 120,
                maxPublicationsPerMonth: 500,
                maxScheduledJobs: 10,
                maxCustomAgents: 20,
                maxTeamMembers: 5,
                maxConnectedPlatforms: 8,
                maxStorageGb: 50,
                features: {
                    webhook_integration: true,
                    custom_branding: true,
                    api_access: true,
                    priority_transcription: true,
                    advanced_analytics: true,
                    image_ai_generation: true,
                    multi_provider_ai: true,
                    scheduled_processing: true,
                },
                sortOrder: 2,
            },
            {
                name: 'enterprise',
                displayName: 'Enterprise',
                description: 'Para grandes medios y redes de canales',
                priceUsd: 199,
                priceUsdYearly: 1990,
                maxTeamMembers: 20,
                maxStorageGb: 200,
                features: {
                    webhook_integration: true,
                    custom_branding: true,
                    api_access: true,
                    priority_transcription: true,
                    advanced_analytics: true,
                    image_ai_generation: true,
                    multi_provider_ai: true,
                    scheduled_processing: true,
                },
                sortOrder: 3,
            },
        ],
        skipDuplicates: true,
    });

    console.log('Seed completed: 4 plans created.');
}

main()
    .catch((e) => {
        console.error('Seed error:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
