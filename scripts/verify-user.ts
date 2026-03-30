import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const user = await prisma.user.update({
    where: { email: 'gamarraadrian200@gmail.com' },
    data: {
        isVerified: true,
        status: 'active',
        verificationToken: null,
        verificationTokenExpiresAt: null,
    },
});

console.log('Verificado:', user.email, '| status:', user.status, '| isVerified:', user.isVerified);

await prisma.$disconnect();
await pool.end();
