import { NextRequest } from 'next/server'
import { db } from '@/db'
import { DEFAULT_USER_ID, iMessages } from '@/db/schema'
import { authMobileRequest } from '../lib'
import { z } from 'zod'
import { and, eq, gte } from 'drizzle-orm'

export const GET = authMobileRequest(async (request: NextRequest) => {
  console.log('GET /api/imessages')

  const { searchParams } = new URL(request.url)
  const afterParam = searchParams.get('after')
  const contactParam = searchParams.get('contact')

  const conditions = [eq(iMessages.userId, DEFAULT_USER_ID)]

  if (contactParam) {
    conditions.push(eq(iMessages.contact, contactParam))
  }

  if (afterParam) {
    const afterDate = new Date(afterParam)
    if (isNaN(afterDate.getTime())) {
      return Response.json(
        { error: 'Invalid date format for "after" parameter' },
        { status: 400 },
      )
    }
    conditions.push(gte(iMessages.date, afterDate))
  }

  const messages = await db.query.iMessages.findMany({
    where: and(...conditions),
    orderBy: (iMessages, { asc }) => [asc(iMessages.date)],
    limit: 1000,
  })

  console.info(
    `Retrieved ${messages.length} iMessages${contactParam ? ` for contact ${contactParam}` : ''}`,
  )

  return Response.json({
    success: true,
    messages,
    count: messages.length,
  })
})

export const POST = authMobileRequest(async (request: NextRequest) => {
  console.log('POST /api/imessages')

  const json = await request.json()

  const parsed = PostSchema.safeParse(json)
  if (!parsed.success) {
    console.warn('Invalid request body', { error: parsed.error })
    return Response.json({ error: parsed.error }, { status: 400 })
  }

  const { messages, syncTime, deviceId, messageCount } = parsed.data

  console.log(
    `Received ${messageCount} iMessages from device ${deviceId} at ${syncTime}`,
  )

  if (messages.length === 0) {
    return Response.json({
      success: true,
      message: 'No messages to sync',
      messageCount: 0,
      syncedAt: new Date().toISOString(),
    })
  }

  const { validMessages, rejectedMessages } = validateMessages(messages)

  const insertedMessages = await insertMessagesInBatches(
    validMessages,
    deviceId,
    syncTime,
  )

  const skippedCount = validMessages.length - insertedMessages.length

  console.info(`Inserted ${insertedMessages.length} iMessages`)
  console.info(`Skipped ${skippedCount} duplicate messages`)
  console.info(`Rejected ${rejectedMessages.length} invalid messages`)
  if (insertedMessages.length > 0) {
    console.info('Inserted message IDs:', insertedMessages.map((m) => m.id))
  }

  return Response.json({
    success: true,
    message: `Stored ${insertedMessages.length} iMessages`,
    messageCount: insertedMessages.length,
    rejectedCount: rejectedMessages.length,
    skippedCount,
    syncedAt: new Date().toISOString(),
  })
})

interface FormattediMessage {
  id: number
  guid: string
  text: string | null
  contact: string
  subject: string | null
  date: string | null
  isFromMe: boolean
  isRead: boolean
  isSent: boolean
  isDelivered: boolean
  hasAttachments: boolean
  service: string
  chatId?: string | null
  chatName?: string | null
}

function validateMessage(
  msg: unknown,
):
  | { success: true; data: FormattediMessage }
  | { success: false; error: string } {
  if (typeof msg !== 'object' || msg === null) {
    return { success: false, error: 'Message must be an object' }
  }

  const m = msg as Record<string, unknown>

  if (typeof m.id !== 'number') {
    return { success: false, error: 'id must be a number' }
  }
  if (typeof m.guid !== 'string') {
    return { success: false, error: 'guid must be a string' }
  }
  if (m.text !== null && typeof m.text !== 'string') {
    return { success: false, error: 'text must be a string or null' }
  }
  if (typeof m.contact !== 'string') {
    return { success: false, error: 'contact must be a string' }
  }
  if (m.subject !== null && typeof m.subject !== 'string') {
    return { success: false, error: 'subject must be a string or null' }
  }
  if (m.date !== null && typeof m.date !== 'string') {
    return { success: false, error: 'date must be a string or null' }
  }
  if (typeof m.isFromMe !== 'boolean') {
    return { success: false, error: 'isFromMe must be a boolean' }
  }
  if (typeof m.isRead !== 'boolean') {
    return { success: false, error: 'isRead must be a boolean' }
  }
  if (typeof m.isSent !== 'boolean') {
    return { success: false, error: 'isSent must be a boolean' }
  }
  if (typeof m.isDelivered !== 'boolean') {
    return { success: false, error: 'isDelivered must be a boolean' }
  }
  if (typeof m.hasAttachments !== 'boolean') {
    return { success: false, error: 'hasAttachments must be a boolean' }
  }
  if (typeof m.service !== 'string') {
    return { success: false, error: 'service must be a string' }
  }
  if (
    m.chatId !== undefined &&
    m.chatId !== null &&
    typeof m.chatId !== 'string'
  ) {
    return { success: false, error: 'chatId must be a string, null, or undefined' }
  }
  if (
    m.chatName !== undefined &&
    m.chatName !== null &&
    typeof m.chatName !== 'string'
  ) {
    return { success: false, error: 'chatName must be a string, null, or undefined' }
  }

  return {
    success: true,
    data: {
      id: m.id,
      guid: m.guid,
      text: m.text as string | null,
      contact: m.contact,
      subject: m.subject as string | null,
      date: m.date as string | null,
      isFromMe: m.isFromMe,
      isRead: m.isRead,
      isSent: m.isSent,
      isDelivered: m.isDelivered,
      hasAttachments: m.hasAttachments,
      service: m.service,
      chatId: m.chatId as string | null | undefined,
      chatName: m.chatName as string | null | undefined,
    },
  }
}

function validateMessages(messages: unknown[]) {
  const validMessages: FormattediMessage[] = []
  const rejectedMessages: Array<{
    index: number
    message: unknown
    error: string
  }> = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as unknown
    const validationResult = validateMessage(message)

    if (!validationResult.success) {
      rejectedMessages.push({
        index: i,
        message,
        error: validationResult.error,
      })
      console.warn(
        `Rejected message at index ${i}:`,
        JSON.stringify({
          message,
          error: validationResult.error,
        }),
      )
      continue
    }

    validMessages.push(validationResult.data)
  }

  return { validMessages, rejectedMessages }
}

async function insertMessagesInBatches(
  validMessages: FormattediMessage[],
  deviceId: string,
  syncTime: string,
) {
  const insertedMessages = []
  const BATCH_SIZE = 50
  const totalBatches = Math.ceil(validMessages.length / BATCH_SIZE)

  for (let i = 0; i < validMessages.length; i += BATCH_SIZE) {
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1
    const batch = validMessages.slice(i, i + BATCH_SIZE)
    const batchValues = batch.map((validMessage) => ({
      userId: DEFAULT_USER_ID,
      messageId: validMessage.id,
      guid: validMessage.guid,
      text: validMessage.text,
      contact: validMessage.contact,
      subject: validMessage.subject,
      date: validMessage.date ? new Date(validMessage.date) : null,
      isFromMe: validMessage.isFromMe ? 1 : 0,
      isRead: validMessage.isRead ? 1 : 0,
      isSent: validMessage.isSent ? 1 : 0,
      isDelivered: validMessage.isDelivered ? 1 : 0,
      hasAttachments: validMessage.hasAttachments ? 1 : 0,
      service: validMessage.service,
      chatId: validMessage.chatId ?? null,
      chatName: validMessage.chatName ?? null,
      deviceId,
      syncTime: new Date(syncTime),
    }))

    const result = await db
      .insert(iMessages)
      .values(batchValues)
      .onConflictDoNothing()
      .returning()

    insertedMessages.push(...result)
    console.info(
      `Batch ${batchNumber}/${totalBatches}: Inserted ${result.length} messages (${insertedMessages.length} total)`,
    )
  }

  return insertedMessages
}

const PostSchema = z.object({
  messages: z.array(z.unknown()),
  syncTime: z.string(),
  deviceId: z.string(),
  messageCount: z.number(),
})
