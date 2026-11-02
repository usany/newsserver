import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable as NodeReadable } from 'node:stream';
import { RouteService } from './route.service.js';
import { StorageService } from './storage.service.js';

/**
 * Serves the object-storage catalog and streams individual objects to the
 * client.
 *
 *   GET /route       -> catalog (JSON list of episodes)
 *   GET /route/:name -> stream one object's bytes
 */
@Controller('route')
export class RouteController {
  constructor(
    private readonly route: RouteService,
    private readonly storage: StorageService,
  ) {}

  /** List objects in the bucket so a React SPA can render and play them. */
  @Get()
  getRoute() {
    return this.route.getRoute();
  }

  /** Stream a single object's bytes to the client. */
  @Get(':name')
  async getStorageObject(
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const key = this.storage.resolveKey(name);
    if (!key) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    const objectUrl = this.storage.getItemUrl(key);
    const upstream = await fetch(objectUrl, {
      headers: this.storage.getSignedHeaders('GET', objectUrl),
    });
    if (!upstream.ok || !upstream.body) {
      throw new HttpException(
        `Failed to fetch object (HTTP ${upstream.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const contentType =
      upstream.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Convert the web ReadableStream to a Node stream for StreamableFile.
    const nodeStream = NodeReadable.fromWeb(
      upstream.body as import('node:stream/web').ReadableStream,
    ) as NodeReadable;

    return new StreamableFile(nodeStream);
  }
}
