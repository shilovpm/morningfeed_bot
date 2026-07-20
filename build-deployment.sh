#!/bin/bash
set -e

echo "🔧 Generating Prisma Client..."
npm run db:generate

echo "🏗️ Building application..."
npm run build

echo "✅ Deployment build complete!"
