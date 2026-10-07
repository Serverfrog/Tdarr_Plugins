import * as path from 'path';
import * as fs from 'fs';
import { CLI } from '../../../../FlowHelpers/1.0.0/cliUtils';
import { getFileName, getContainer } from '../../../../FlowHelpers/1.0.0/fileUtils';
import {
  IpluginDetails,
  IpluginInputArgs,
  IpluginOutputArgs,
} from '../../../../FlowHelpers/1.0.0/interfaces/interfaces';
import { IFileObject } from '../../../../FlowHelpers/1.0.0/interfaces/synced/IFileObject';

/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
const details = (): IpluginDetails => ({
  name: 'Anime Chapters (AniSkip)',
  description: 'Fetches anime opening/ending/recap skip timestamps from AniSkip (via MAL ID or Sonarr/TVDB ID) '
    + 'and embeds them as Matroska chapters using mkvpropedit.',
  style: {
    borderColor: '#7952b3',
  },
  tags: 'anime,chapters,aniskip,mkvpropedit,sonarr,metadata',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.11.01',
  sidebarPosition: -1,
  icon: 'faFilm',
  inputs: [
    {
      label: 'Use Sonarr',
      name: 'use_sonarr',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: {
        type: 'switch',
      },
      tooltip: 'Enable Sonarr integration to parse series information and map TVDB ID / series title.',
    },
    {
      label: 'Sonarr Host',
      name: 'sonarr_host',
      type: 'string',
      defaultValue: 'http://localhost:8989',
      inputUI: {
        type: 'text',
      },
      tooltip: 'Sonarr URL including protocol and port, e.g. http://192.168.1.50:8989 or https://sonarr.domain.com',
    },
    {
      label: 'Sonarr API Key',
      name: 'sonarr_api_key',
      type: 'string',
      defaultValue: '',
      inputUI: {
        type: 'text',
      },
      tooltip: 'API key for authenticating with Sonarr.',
    },
    {
      label: 'Continue If No Anime Found',
      name: 'continue_if_no_anime_found',
      type: 'boolean',
      defaultValue: 'true',
      inputUI: {
        type: 'switch',
      },
      tooltip: 'If enabled, routes to output 3 when Anime or MAL ID cannot be identified instead of failing the flow.',
    },
    {
      label: 'Continue If No Skips Found',
      name: 'continue_if_no_skips',
      type: 'boolean',
      defaultValue: 'true',
      inputUI: {
        type: 'switch',
      },
      tooltip: 'If enabled, routes to output 2 when AniSkip has no skip entries for this episode instead of failing.',
    },
    {
      label: 'Skip If Chapters Exist',
      name: 'skip_if_chapters_exist',
      type: 'boolean',
      defaultValue: 'true',
      inputUI: {
        type: 'switch',
      },
      tooltip: 'Skip adding AniSkip chapters if the file already contains chapters.',
    },
    {
      label: 'Skip Types',
      name: 'skip_types',
      type: 'string',
      defaultValue: 'op, ed, mixed-op, mixed-ed, recap, preview',
      inputUI: {
        type: 'text',
      },
      tooltip: 'Comma-separated list of skip types to query from AniSkip: op, ed, mixed-op, mixed-ed, recap, preview',
    },
    {
      label: 'Custom MAL ID (Optional)',
      name: 'custom_mal_id',
      type: 'string',
      defaultValue: '',
      inputUI: {
        type: 'text',
      },
      tooltip: 'Optional manual MyAnimeList ID override or template variable {{args.variables.user.mal_id}}.',
    },
    {
      label: 'Custom Episode Number (Optional)',
      name: 'custom_episode_number',
      type: 'string',
      defaultValue: '',
      inputUI: {
        type: 'text',
      },
      tooltip: 'Optional manual episode number override or template variable.',
    },
  ],
  outputs: [
    {
      number: 1,
      tooltip: 'Skips found and chapters successfully added to file',
    },
    {
      number: 2,
      tooltip: 'No chapters added (file already has chapters or no skip times found on AniSkip)',
    },
    {
      number: 3,
      tooltip: 'Anime/MAL ID not found or unsupported container (flow continued)',
    },
  ],
});

export interface ISkipInterval {
  startTime: number;
  endTime: number;
}

export interface IAniSkipResult {
  interval: ISkipInterval;
  skipType: string;
  skipId?: string;
  episodeLength?: number;
}

export interface IAniSkipResponse {
  found: boolean;
  results?: IAniSkipResult[];
  message?: string;
  statusCode?: number;
}

export interface IChapterSegment {
  startTime: number;
  endTime?: number;
  title: string;
}

/**
 * Format numeric seconds to Matroska XML timestamp: HH:MM:SS.nnn000000
 */
export const formatMatroskaTimestamp = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Number.isNaN(totalSeconds) ? 0 : totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const fraction = safeSeconds - Math.floor(safeSeconds);
  const nanoseconds = Math.round(fraction * 1_000_000_000);

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  const nanoPad = String(nanoseconds).padStart(9, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${nanoPad}`;
};

/**
 * Maps raw AniSkip type to human-readable chapter title.
 */
export const getChapterTitleForSkipType = (skipType: string): string => {
  switch (skipType.toLowerCase()) {
    case 'op':
      return 'Opening';
    case 'ed':
      return 'Ending';
    case 'mixed-op':
      return 'Mixed Opening';
    case 'mixed-ed':
      return 'Mixed Ending';
    case 'recap':
      return 'Recap';
    case 'preview':
      return 'Preview';
    default:
      return skipType.charAt(0).toUpperCase() + skipType.slice(1);
  }
};

/**
 * Detects if the media file already contains chapters from MediaInfo, ffprobe, or metadata.
 */
export const hasExistingChapters = (fileObj: IFileObject): boolean => {
  if (!fileObj) {
    return false;
  }

  // 1. ffprobe chapters
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ffprobeObj = fileObj.ffProbeData as any;
  if (
    Array.isArray(ffprobeObj?.chapters)
    && ffprobeObj.chapters.length > 0
  ) {
    return true;
  }

  // 2. MediaInfo track chapters (Menu / Chapters tracks or General track chapter counts)
  if (Array.isArray(fileObj.mediaInfo?.track)) {
    for (let i = 0; i < fileObj.mediaInfo.track.length; i += 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const track = fileObj.mediaInfo.track[i] as any;
      const type = (track['@type'] || '').toLowerCase();
      if (type === 'menu' || type === 'chapters') {
        return true;
      }
      if (type === 'general') {
        const menuCount = parseInt(String(track.MenuCount || '0'), 10);
        if (!Number.isNaN(menuCount) && menuCount > 0) {
          return true;
        }
        if (track.Chapters || (track.extra && (track.extra.Chapter_Count || track.extra.Chapters))) {
          return true;
        }
      }
      if (track.extra && (track.extra.Chapter_Count || track.extra.Chapters)) {
        return true;
      }
    }
  }

  // 3. ExifTool / meta tags
  if (fileObj.meta) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = fileObj.meta as any;
    if (meta.ChapterCount && parseInt(String(meta.ChapterCount), 10) > 0) {
      return true;
    }
    if (meta.Chapters && Array.isArray(meta.Chapters) && meta.Chapters.length > 0) {
      return true;
    }
  }

  // 4. Direct chapters property on fileObj if present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (Array.isArray((fileObj as any).chapters) && (fileObj as any).chapters.length > 0) {
    return true;
  }

  return false;
};

/**
 * Generates Matroska Chapters XML format string from skip intervals and total duration.
 */
export const generateMatroskaChaptersXml = (
  skips: IAniSkipResult[],
  totalDurationSeconds: number,
): string => {
  // Sort skips by startTime ascending
  const sortedSkips = [...skips].sort((a, b) => a.interval.startTime - b.interval.startTime);

  const segments: IChapterSegment[] = [];
  let currentPosition = 0;
  let episodePartCount = 1;

  for (let i = 0; i < sortedSkips.length; i += 1) {
    const skip = sortedSkips[i];
    const { startTime, endTime } = skip.interval;

    // If there is a gap between current position and the start of the skip, create an Episode / Prologue chapter
    if (startTime > currentPosition + 1.0) {
      const isStart = currentPosition === 0;
      let title = 'Prologue';
      if (!isStart) {
        title = `Episode Part ${episodePartCount}`;
        episodePartCount += 1;
      }
      segments.push({
        startTime: currentPosition,
        endTime: startTime,
        title,
      });
    }

    // Add skip chapter
    segments.push({
      startTime,
      endTime,
      title: getChapterTitleForSkipType(skip.skipType),
    });

    currentPosition = Math.max(currentPosition, endTime);
  }

  // If there is remaining time after the last skip
  if (totalDurationSeconds > currentPosition + 1.0) {
    const hasEnding = segments.some((s) => s.title.includes('Ending'));
    const title = hasEnding ? 'Preview / Epilogue' : `Episode Part ${episodePartCount}`;
    segments.push({
      startTime: currentPosition,
      endTime: totalDurationSeconds,
      title,
    });
  }

  // If no segments generated (e.g. empty), return minimal xml
  if (segments.length === 0 && sortedSkips.length > 0) {
    for (let i = 0; i < sortedSkips.length; i += 1) {
      const skip = sortedSkips[i];
      segments.push({
        startTime: skip.interval.startTime,
        endTime: skip.interval.endTime,
        title: getChapterTitleForSkipType(skip.skipType),
      });
    }
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<Chapters>\n';
  xml += '  <EditionEntry>\n';
  xml += '    <EditionFlagHidden>0</EditionFlagHidden>\n';
  xml += '    <EditionFlagDefault>1</EditionFlagDefault>\n';

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    xml += '    <ChapterAtom>\n';
    xml += `      <ChapterUID>${1000000 + i + 1}</ChapterUID>\n`;
    xml += `      <ChapterTimeStart>${formatMatroskaTimestamp(seg.startTime)}</ChapterTimeStart>\n`;
    if (seg.endTime !== undefined && seg.endTime > seg.startTime) {
      xml += `      <ChapterTimeEnd>${formatMatroskaTimestamp(seg.endTime)}</ChapterTimeEnd>\n`;
    }
    xml += '      <ChapterFlagHidden>0</ChapterFlagHidden>\n';
    xml += '      <ChapterFlagEnabled>1</ChapterFlagEnabled>\n';
    xml += '      <ChapterDisplay>\n';
    xml += `        <ChapterString>${seg.title}</ChapterString>\n`;
    xml += '        <ChapterLanguage>eng</ChapterLanguage>\n';
    xml += '      </ChapterDisplay>\n';
    xml += '    </ChapterAtom>\n';
  }

  xml += '  </EditionEntry>\n';
  xml += '</Chapters>\n';

  return xml;
};

/**
 * Extract episode number from filename or query Sonarr.
 */
export const extractEpisodeInfo = (fileName: string): { season?: number; episode?: number } => {
  // Pattern 1: S01E05 or S1E5 or S01.E05
  const sPattern = /\bS(\d{1,3})[.\s_-]*E(\d{1,4})\b/i.exec(fileName);
  if (sPattern) {
    return {
      season: parseInt(sPattern[1], 10),
      episode: parseInt(sPattern[2], 10),
    };
  }

  // Pattern 2: 1x05
  const xPattern = /\b(\d{1,3})x(\d{1,4})\b/i.exec(fileName);
  if (xPattern) {
    return {
      season: parseInt(xPattern[1], 10),
      episode: parseInt(xPattern[2], 10),
    };
  }

  // Pattern 3: EP05 / E05 / Episode 05 / Ep.05
  const epPattern = /\b(?:EP|E|Episode|Ep)[.\s_-]*(\d{1,4})\b/i.exec(fileName);
  if (epPattern) {
    return {
      episode: parseInt(epPattern[1], 10),
    };
  }

  // Pattern 4: Anime standard hyphen numbering: " - 05 ", " - 05 [", " - 05 ("
  const dashPattern = /(?: - | -|[-_ ])(\d{1,4})(?:v\d)?(?:\s*\[|\s*\(|\s*\.|\s*-\s*|\s+|$)/i.exec(fileName);
  if (dashPattern) {
    return {
      episode: parseInt(dashPattern[1], 10),
    };
  }

  // Pattern 5: Standalone bracketed episode: "[05]"
  const bracketPattern = /\[(\d{1,4})(?:v\d)?\]/.exec(fileName);
  if (bracketPattern) {
    return {
      episode: parseInt(bracketPattern[1], 10),
    };
  }

  return {};
};

/**
 * Extract MyAnimeList ID directly from filename or directory path.
 */
export const extractMalIdFromFilename = (fileNameOrPath: string): number | undefined => {
  if (!fileNameOrPath) return undefined;
  const malMatch = /(?:\[|\{|\b)(?:mal(?:id)?|myanimelist)[-_:= ]?(\d+)(?:\]|\}|\b)/i.exec(fileNameOrPath);
  if (malMatch) {
    const id = parseInt(malMatch[1], 10);
    if (!Number.isNaN(id) && id > 0) {
      return id;
    }
  }
  return undefined;
};

/**
 * Extract TVDB ID directly from filename or directory path.
 */
export const extractTvdbIdFromFilename = (fileNameOrPath: string): number | undefined => {
  if (!fileNameOrPath) return undefined;
  const tvdbMatch = /(?:\[|\{|\b)(?:tvdb(?:id)?)[-_:= ]?(\d+)(?:\]|\}|\b)/i.exec(fileNameOrPath);
  if (tvdbMatch) {
    const id = parseInt(tvdbMatch[1], 10);
    if (!Number.isNaN(id) && id > 0) {
      return id;
    }
  }
  return undefined;
};

/**
 * Extract AniList ID directly from filename or directory path.
 */
export const extractAnilistIdFromFilename = (fileNameOrPath: string): number | undefined => {
  if (!fileNameOrPath) return undefined;
  const anilistMatch = /(?:\[|\{|\b)(?:anilist(?:id)?)[-_:= ]?(\d+)(?:\]|\}|\b)/i.exec(fileNameOrPath);
  if (anilistMatch) {
    const id = parseInt(anilistMatch[1], 10);
    if (!Number.isNaN(id) && id > 0) {
      return id;
    }
  }
  return undefined;
};

/**
 * Extract IDs from filename and full path (TVDB ID, MAL ID, AniList ID).
 */
export const extractIdsFromFilename = (
  fileNameOrPath: string,
): { tvdbId?: number; malId?: number; anilistId?: number } => {
  const result: { tvdbId?: number; malId?: number; anilistId?: number } = {};
  const malId = extractMalIdFromFilename(fileNameOrPath);
  if (malId) result.malId = malId;

  const tvdbId = extractTvdbIdFromFilename(fileNameOrPath);
  if (tvdbId) result.tvdbId = tvdbId;

  const anilistId = extractAnilistIdFromFilename(fileNameOrPath);
  if (anilistId) result.anilistId = anilistId;

  return result;
};

/**
 * Resolve MyAnimeList ID from Anime Title using AniList GraphQL API.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const resolveMalIdFromTitle = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axiosClient: (opts: Record<string, unknown>) => Promise<any>,
  title: string,
  log: (msg: string) => void,
): Promise<number | undefined> => {
  try {
    log(`[AniList Search] Searching AniList GraphQL API for title: "${title}"`);
    const query = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
          idMal
          title {
            romaji
            english
            native
          }
        }
      }
    `;

    const res = await axiosClient({
      method: 'post',
      url: 'https://graphql.anilist.co',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      data: JSON.stringify({
        query,
        variables: { search: title },
      }),
      timeout: 15000,
    });

    const media = res.data?.data?.Media;
    if (media?.idMal) {
      const displayTitle = media.title?.english || media.title?.romaji || title;
      log(`[AniList Search] Found MAL ID: ${media.idMal} for "${displayTitle}"`);
      return Number(media.idMal);
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    log(`[AniList Search] Warning: Could not resolve MAL ID via AniList GraphQL: ${err.message}`);
  }
  return undefined;
};

/**
 * Resolve MyAnimeList ID from TVDB ID using Kitsu mapping API.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const resolveMalIdFromTvdbId = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axiosClient: (opts: Record<string, unknown>) => Promise<any>,
  tvdbId: number,
  log: (msg: string) => void,
): Promise<number | undefined> => {
  try {
    log(`[Mapping Search] Querying Kitsu mapping API for TVDB ID: ${tvdbId}`);
    const url = 'https://kitsu.io/api/edge/mappings?filter[external_site]=thetvdb/series'
      + `&filter[external_id]=${tvdbId}&include=item`;
    const res = await axiosClient({
      method: 'get',
      url,
      headers: {
        Accept: 'application/vnd.api+json',
      },
      timeout: 15000,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = res.data?.included?.find((inc: any) => inc.type === 'anime');
    if (item?.attributes?.canonicalTitle) {
      const animeTitle = item.attributes.canonicalTitle;
      log(`[Mapping Search] Kitsu resolved TVDB ID ${tvdbId} to title: "${animeTitle}". Querying AniList for MAL ID.`);
      const malId = await resolveMalIdFromTitle(axiosClient, animeTitle, log);
      if (malId) return malId;
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    log(`[Mapping Search] Warning: Kitsu mapping lookup for TVDB ID ${tvdbId} failed: ${err.message}`);
  }
  return undefined;
};

/**
 * Main Flow Plugin
 */
const plugin = async (args: IpluginInputArgs): Promise<IpluginOutputArgs> => {
  const lib = require('../../../../../methods/lib')();
  // eslint-disable-next-line no-param-reassign
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  const {
    use_sonarr,
    sonarr_host,
    sonarr_api_key,
    continue_if_no_anime_found,
    continue_if_no_skips,
    skip_if_chapters_exist,
    skip_types,
    custom_mal_id,
    custom_episode_number,
  } = args.inputs;

  const continueIfNoAnime = String(continue_if_no_anime_found).toLowerCase() === 'true';
  const continueIfNoSkips = String(continue_if_no_skips).toLowerCase() === 'true';
  const skipIfChaptersExist = String(skip_if_chapters_exist).toLowerCase() === 'true';
  const useSonarr = String(use_sonarr).toLowerCase() === 'true';
  const sonarrHost = String(sonarr_host).trim().replace(/\/+$/, '');
  const sonarrApiKey = String(sonarr_api_key).trim();

  const filePath = args.inputFileObj?._id ?? '';
  const fileName = getFileName(filePath);
  const container = (args.inputFileObj?.container || getContainer(filePath)).toLowerCase();

  args.jobLog(`[AnimeChapters] Processing file: ${filePath}`);
  args.jobLog(`[AnimeChapters] File container: ${container}`);

  // Container verification: mkvpropedit only works on Matroska files
  if (container !== 'mkv') {
    const errorMsg = `[AnimeChapters] File container is '${container}'. `
      + 'mkvpropedit only supports Matroska (.mkv) files.';
    args.jobLog(errorMsg);
    if (!continueIfNoAnime) {
      args.logOutcome('Failed: Unsupported container');
      throw new Error(errorMsg);
    }
    args.logOutcome('Unsupported container - skipping');
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 3,
      variables: args.variables,
    };
  }

  // Check if file already contains chapters and skip option is enabled
  if (skipIfChaptersExist && hasExistingChapters(args.inputFileObj)) {
    const msg = '[AnimeChapters] File already contains chapters and \'Skip If Chapters Exist\' is enabled. '
      + 'Skipping AniSkip chapter generation.';
    args.jobLog(msg);
    args.logOutcome('Chapters already exist - skipping');
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  // Step 1: Determine Episode Number & MAL ID
  let malId: number | undefined;
  let episodeNumber: number | undefined;
  let extractedTitle: string | undefined;

  // Check Custom MAL ID input
  if (custom_mal_id && String(custom_mal_id).trim() !== '') {
    const parsedMal = parseInt(String(custom_mal_id).trim(), 10);
    if (!Number.isNaN(parsedMal) && parsedMal > 0) {
      malId = parsedMal;
      args.jobLog(`[AnimeChapters] Using custom MAL ID provided in plugin inputs: ${malId}`);
    }
  }

  // Check Custom Episode Number input
  if (custom_episode_number && String(custom_episode_number).trim() !== '') {
    const parsedEp = parseInt(String(custom_episode_number).trim(), 10);
    if (!Number.isNaN(parsedEp) && parsedEp > 0) {
      episodeNumber = parsedEp;
      args.jobLog(`[AnimeChapters] Using custom Episode Number provided in plugin inputs: ${episodeNumber}`);
    }
  }

  // Check user flow variables for mal_id or tvdb_id
  if (!malId && args.variables?.user?.mal_id) {
    const parsed = parseInt(args.variables.user.mal_id, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      malId = parsed;
      args.jobLog(`[AnimeChapters] Found MAL ID from user flow variable 'mal_id': ${malId}`);
    }
  }

  // Extract direct MAL ID from Filename and Path
  const directMalId = extractMalIdFromFilename(filePath);
  if (!malId && directMalId) {
    malId = directMalId;
    args.jobLog(`[AnimeChapters] Extracted MAL ID directly from filename/path: ${malId}`);
  }

  // Extract TVDB ID from Filename and Path if present
  let tvdbId = extractTvdbIdFromFilename(filePath);
  if (tvdbId) {
    args.jobLog(`[AnimeChapters] Extracted TVDB ID from filename/path: ${tvdbId}`);
  }

  if (episodeNumber === undefined) {
    const epInfo = extractEpisodeInfo(fileName);
    if (epInfo.episode !== undefined) {
      episodeNumber = epInfo.episode;
      args.jobLog(`[AnimeChapters] Extracted Episode Number ${episodeNumber} from filename`);
    }
  }

  // Sonarr Integration
  if (useSonarr && sonarrHost && sonarrApiKey) {
    args.jobLog(`[AnimeChapters] Querying Sonarr at ${sonarrHost} for file: "${fileName}"`);
    try {
      const parseRes = await args.deps.axios({
        method: 'get',
        url: `${sonarrHost}/api/v3/parse?title=${encodeURIComponent(fileName)}`,
        headers: {
          'X-Api-Key': sonarrApiKey,
          Accept: 'application/json',
        },
        timeout: 15000,
      });

      const series = parseRes.data?.series;
      const episodes = parseRes.data?.episodes;
      const parsedInfo = parseRes.data?.parsedEpisodeInfo;

      if (series) {
        extractedTitle = series.title;
        args.jobLog(`[AnimeChapters] Sonarr recognized series: "${series.title}" (TVDB ID: ${series.tvdbId})`);

        if (!tvdbId && series.tvdbId) {
          tvdbId = series.tvdbId;
        }
      }

      if (episodeNumber === undefined) {
        if (parsedInfo?.episodeNumbers && parsedInfo.episodeNumbers.length > 0) {
          [episodeNumber] = parsedInfo.episodeNumbers;
          args.jobLog(`[AnimeChapters] Sonarr parsed episode number: ${episodeNumber}`);
        } else if (episodes && episodes.length > 0 && episodes[0]?.episodeNumber !== undefined) {
          episodeNumber = episodes[0].episodeNumber;
          args.jobLog(`[AnimeChapters] Sonarr returned episode number: ${episodeNumber}`);
        }
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (sonarrErr: any) {
      args.jobLog(`[AnimeChapters] Warning: Sonarr parse query failed: ${sonarrErr.message}`);
    }
  }

  // If MAL ID is still unknown, try title search or TVDB ID lookup
  if (!malId && extractedTitle) {
    args.jobLog(`[AnimeChapters] Attempting AniList search for series title: "${extractedTitle}"...`);
    malId = await resolveMalIdFromTitle(args.deps.axios, extractedTitle, args.jobLog);
  }

  if (!malId && tvdbId) {
    args.jobLog(`[AnimeChapters] TVDB ID ${tvdbId} found. Attempting resolution to MAL ID...`);
    malId = await resolveMalIdFromTvdbId(args.deps.axios, tvdbId, args.jobLog);
  }

  // Fallback: Clean title from filename for search if still missing
  if (!malId) {
    const cleanTitle = fileName
      .replace(/\[.*?\]|\(.*?\)|_|\./g, ' ')
      .replace(
        /\b(S\d+E\d+|\d+x\d+|E\d+|EP\d+|1080p|720p|480p|2160p|4k|hevc|x264|x265|aac|flac|dts|bluray|web-dl|hdtv)\b/gi,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanTitle.length > 2) {
      args.jobLog(`[AnimeChapters] Attempting AniList search with cleaned filename title: "${cleanTitle}"...`);
      malId = await resolveMalIdFromTitle(args.deps.axios, cleanTitle, args.jobLog);
    }
  }

  // Check if we have both MAL ID and Episode Number
  if (!malId || episodeNumber === undefined) {
    const notFoundMsg = `[AnimeChapters] Could not determine required info: MAL ID = ${malId ?? 'NOT FOUND'}, `
      + `Episode Number = ${episodeNumber ?? 'NOT FOUND'}`;
    args.jobLog(notFoundMsg);

    if (!continueIfNoAnime) {
      args.logOutcome('Failed: Anime / MAL ID not found');
      throw new Error(notFoundMsg);
    }

    args.logOutcome('Anime / MAL ID not found - continuing flow');
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 3,
      variables: args.variables,
    };
  }

  args.jobLog(`[AnimeChapters] Proceeding with MAL ID: ${malId}, Episode: ${episodeNumber}`);

  // Step 2: Query AniSkip API
  const rawTypes = String(skip_types || 'op, ed, mixed-op, mixed-ed, recap, preview')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  // Extract episode duration if available
  let durationSeconds = 0;
  if (args.inputFileObj?.mediaInfo?.track) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const videoTrack = args.inputFileObj.mediaInfo.track.find((t: any) => (
      t['@type'] === 'Video' || t['@type'] === 'General'
    ));
    if (videoTrack?.Duration) {
      durationSeconds = parseFloat(videoTrack.Duration);
    }
  }
  if (!durationSeconds && args.inputFileObj?.ffProbeData?.format?.duration) {
    durationSeconds = parseFloat(String(args.inputFileObj.ffProbeData.format.duration));
  }
  if (Number.isNaN(durationSeconds)) {
    durationSeconds = 0;
  }

  const queryParams = rawTypes.map((t) => `types[]=${encodeURIComponent(t)}`).join('&');
  const episodeLenParam = durationSeconds > 0 ? `&episodeLength=${durationSeconds.toFixed(3)}` : '';
  const aniskipUrl = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNumber}?${queryParams}${episodeLenParam}`;

  args.jobLog(`[AnimeChapters] Requesting AniSkip API: ${aniskipUrl}`);

  let aniskipData: IAniSkipResponse | null = null;
  try {
    const res = await args.deps.axios({
      method: 'get',
      url: aniskipUrl,
      headers: {
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    aniskipData = res.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (apiErr: any) {
    if (apiErr.response?.status === 404) {
      args.jobLog(`[AnimeChapters] AniSkip returned 404: No skips found for MAL ${malId} Episode ${episodeNumber}.`);
    } else {
      const errStatus = apiErr.response?.status ?? 'ERR';
      args.jobLog(`[AnimeChapters] AniSkip API request returned status ${errStatus}: ${apiErr.message}`);
    }
  }

  const results = aniskipData?.results ?? [];
  if (!aniskipData?.found || results.length === 0) {
    const noSkipsMsg = `[AnimeChapters] No skip times found for MAL ID ${malId} Episode ${episodeNumber}`;
    args.jobLog(noSkipsMsg);

    if (!continueIfNoSkips) {
      args.logOutcome('Failed: No skip times found');
      throw new Error(noSkipsMsg);
    }

    args.logOutcome('No skip times found - continuing flow');
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  args.jobLog(`[AnimeChapters] Found ${results.length} skip segment(s) from AniSkip:`);
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    const title = getChapterTitleForSkipType(item.skipType);
    const startStr = item.interval.startTime.toFixed(2);
    const endStr = item.interval.endTime.toFixed(2);
    const durStr = (item.interval.endTime - item.interval.startTime).toFixed(2);
    args.jobLog(`  - [${item.skipType.toUpperCase()} - ${title}] ${startStr}s -> ${endStr}s (${durStr}s)`);
  }

  // Step 3: Generate XML Chapters & Run mkvpropedit
  const chaptersXml = generateMatroskaChaptersXml(results, durationSeconds);
  args.jobLog('[AnimeChapters] Generated Matroska XML Chapter definition successfully.');

  const workDir = args.workDir || process.cwd();
  const tempXmlPath = path.join(workDir, `chapters_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.xml`);

  try {
    await fs.promises.writeFile(tempXmlPath, chaptersXml, 'utf-8');
    args.jobLog(`[AnimeChapters] Wrote temporary chapter XML to: ${tempXmlPath}`);

    const mkvpropeditCli = args.mkvpropeditPath || 'mkvpropedit';
    const cliArgs = ['--chapters', tempXmlPath, filePath];

    args.jobLog(`[AnimeChapters] Executing mkvpropedit on: ${filePath}`);

    const cli = new CLI({
      cli: mkvpropeditCli,
      spawnArgs: cliArgs,
      spawnOpts: {},
      jobLog: args.jobLog,
      outputFilePath: '',
      inputFileObj: args.inputFileObj,
      logFullCliOutput: args.logFullCliOutput,
      updateWorker: args.updateWorker,
      args,
    });

    const res = await cli.runCli();

    if (res.cliExitCode === 1 && !cli.cancelled) {
      args.jobLog('[AnimeChapters] mkvpropedit completed with warnings.');
    } else if (res.cliExitCode !== 0) {
      const err = '[AnimeChapters] Running mkvpropedit failed with non-zero exit code';
      args.jobLog(err);
      throw new Error(err);
    }

    args.jobLog(`[AnimeChapters] Successfully embedded ${results.length} AniSkip chapters into: ${filePath}`);
    args.logOutcome('Chapters successfully added');

    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 1,
      variables: args.variables,
    };
  } finally {
    // Clean up temporary XML file
    try {
      if (fs.existsSync(tempXmlPath)) {
        await fs.promises.unlink(tempXmlPath);
        args.jobLog(`[AnimeChapters] Cleaned up temporary XML file: ${tempXmlPath}`);
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (cleanupErr: any) {
      args.jobLog(`[AnimeChapters] Notice: Could not remove temporary XML file: ${cleanupErr.message}`);
    }
  }
};

export {
  details,
  plugin,
};
