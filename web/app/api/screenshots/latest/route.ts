import { db } from '@/db'
import { DEFAULT_USER_ID, Screenshots } from '@/db/schema'
import { NextRequest } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'

export async function GET(request: NextRequest) {
  console.log('GET /api/screenshots/latest')

  const searchParams = request.nextUrl.searchParams
  const limit = parseInt(searchParams.get('limit') || '1', 10)
  const displayId = searchParams.get('displayId')

  if (limit < 1 || limit > 100) {
    return Response.json(
      { error: 'Limit must be between 1 and 100' },
      { status: 400 },
    )
  }

  const conditions = [eq(Screenshots.userId, DEFAULT_USER_ID)]

  if (displayId) {
    conditions.push(eq(Screenshots.displayId, displayId))
  }

  const screenshots = await db
    .select()
    .from(Screenshots)
    .where(and(...conditions))
    .orderBy(desc(Screenshots.timestamp))
    .limit(limit)

  console.info(`Returning ${screenshots.length} screenshot(s)`)

  return Response.json({
    success: true,
    count: screenshots.length,
    screenshots,
  })
}
