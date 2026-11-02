import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { StorageService } from './storage.service.js';

/** An episode entry exposed to the SPA via /route. */
export interface Episode {
  /** SPA-facing URL, served by GET /route/:name. */
  url: string;
  /** Audio duration in seconds (float), or null when unknown. */
  duration: number | null;
  /** Object size in bytes. */
  size: number;
}

/** Shape returned by GET /route. */
export interface RouteResponse {
  storage: {
    endpoint: string;
  };
  episodes: Episode[];
}

@Injectable()
export class RouteService {
  constructor(private readonly storage: StorageService) {}

  /**
   * Lists the objects in the configured object storage bucket so a React SPA
   * can render and play them. Each episode carries a SPA-facing `/route`
   * URL plus its audio duration (seconds) and byte size.
   */
  async getRoute(): Promise<RouteResponse> {
    const endpoint = this.storage.getStorageBaseUrl();
    if (!endpoint) {
      throw new HttpException(
        'Object storage is not configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const items = await this.storage.listItems();
    const episodes = await Promise.all(
      items
        .filter((i) => i.name.length > 0)
        .map(async (i) => {
          const duration = await this.storage.getAudioDuration(i.name).catch(
            () => null,
          );
          return {
            url: `/route/${i.name}`,
            duration,
            size: i.size,
          };
        }),
    );

    return {
      storage: { endpoint },
      episodes,
    };
  }
}
