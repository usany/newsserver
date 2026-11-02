import { NextResponse } from 'next/server'
import config from '../../../../config/news.json' with { type: 'json' }

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? config.storage.endpoint

export async function GET(request, { params }) {
  const { path = [] } = (await params) ?? {}
  const key = path.join('/')

  if (!key) {
    return NextResponse.json({ error: 'Missing object key' }, { status: 400 })
  }

  const url = S3_ENDPOINT.endsWith('/')
    ? S3_ENDPOINT + key
    : S3_ENDPOINT + '/' + key

  const res = await fetch(url, {
    cache: 'no-store',
  })

  if (!res.ok) {
    return NextResponse.json(
      { error: `Object not found (${res.status})` },
      { status: res.status }
    )
  }

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  const contentLength = res.headers.get('content-length')
  const etag = res.headers.get('etag')

  const headers = {
    'Content-Type': contentType,
    // Cache aggressively: audio files are immutable once uploaded.
    // Browser caches up to 7 days; ETag enables cheap 304 revalidation after that.
    'Cache-Control': 'public, max-age=604800, immutable',
    ...(contentLength ? { 'Content-Length': contentLength } : {}),
    ...(etag ? { ETag: etag } : {}),
    'Access-Control-Allow-Origin': '*',
  }

  // Stream the bytes straight from Oracle instead of buffering the whole
  // object in memory — the client starts receiving audio almost immediately.
  if (res.body) {
    return new NextResponse(res.body, { status: 200, headers })
  }

  // Fallback for runtimes without streaming support.
  const arrayBuffer = await res.arrayBuffer()
  return new NextResponse(arrayBuffer, { status: 200, headers })
}
