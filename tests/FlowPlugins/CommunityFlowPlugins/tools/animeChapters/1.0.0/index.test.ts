import {
  plugin,
  details,
  formatMatroskaTimestamp,
  getChapterTitleForSkipType,
  generateMatroskaChaptersXml,
  extractEpisodeInfo,
  extractIdsFromFilename,
  extractMalIdFromFilename,
  extractTvdbIdFromFilename,
  resolveMalIdFromTitle,
  resolveMalIdFromTvdbId,
  hasExistingChapters,
} from '../../../../../../FlowPluginsTs/CommunityFlowPlugins/tools/animeChapters/1.0.0/index';
import { IpluginInputArgs } from '../../../../../../FlowPluginsTs/FlowHelpers/1.0.0/interfaces/interfaces';
import { IFileObject } from '../../../../../../FlowPluginsTs/FlowHelpers/1.0.0/interfaces/synced/IFileObject';

const sampleH264 = require('../../../../../sampleData/media/sampleH264_1.json');

// Mock CLI class
let mockRunCli: jest.Mock;
let mockCancelled: boolean;

jest.mock('../../../../../../FlowPluginsTs/FlowHelpers/1.0.0/cliUtils', () => ({
  CLI: jest.fn().mockImplementation(() => ({
    runCli: mockRunCli,
    get cancelled() {
      return mockCancelled;
    },
  })),
}));

// Mock methods/lib
jest.mock('../../../../../../methods/lib', () => () => ({
  loadDefaultValues: jest.fn((inputs) => inputs),
}));

describe('Anime Chapters (AniSkip) Flow Plugin', () => {
  let baseArgs: IpluginInputArgs;
  let mockAxios: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunCli = jest.fn().mockResolvedValue({ cliExitCode: 0 });
    mockCancelled = false;
    mockAxios = jest.fn();

    const mediaObj = JSON.parse(JSON.stringify(sampleH264)) as IFileObject;
    mediaObj._id = '/anime/Frieren [tvdb-410023]/[SubsPlease] Sousou no Frieren - 05 [mal-52991] (1080p).mkv';
    mediaObj.container = 'mkv';
    mediaObj.mediaInfo = {
      track: [
        {
          '@type': 'General',
          Duration: '1440.0',
        },
        {
          '@type': 'Video',
          Duration: '1440.0',
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    baseArgs = {
      inputs: {
        use_sonarr: 'false',
        sonarr_host: 'http://localhost:8989',
        sonarr_api_key: 'sonarr_secret_key',
        continue_if_no_anime_found: 'true',
        continue_if_no_skips: 'true',
        skip_types: 'op, ed, mixed-op, mixed-ed, recap, preview',
        custom_mal_id: '',
        custom_episode_number: '',
      },
      variables: {
        user: {},
      } as IpluginInputArgs['variables'],
      inputFileObj: mediaObj,
      jobLog: jest.fn(),
      logOutcome: jest.fn(),
      updateWorker: jest.fn(),
      mkvpropeditPath: '/usr/bin/mkvpropedit',
      workDir: process.cwd(),
      logFullCliOutput: false,
      deps: {
        axios: mockAxios,
      },
    } as unknown as IpluginInputArgs;
  });

  describe('Plugin Details', () => {
    it('should provide valid plugin metadata and outputs', () => {
      const info = details();
      expect(info.name).toBe('Anime Chapters (AniSkip)');
      expect(info.outputs).toHaveLength(3);
      expect(info.inputs.length).toBeGreaterThan(0);
    });
  });

  describe('Helper Functions', () => {
    it('should format seconds to Matroska XML timestamp correctly', () => {
      expect(formatMatroskaTimestamp(0)).toBe('00:00:00.000000000');
      expect(formatMatroskaTimestamp(90.5)).toBe('00:01:30.500000000');
      expect(formatMatroskaTimestamp(3665.123456789)).toBe('01:01:05.123456789');
    });

    it('should map skip types to chapter titles', () => {
      expect(getChapterTitleForSkipType('op')).toBe('Opening');
      expect(getChapterTitleForSkipType('ed')).toBe('Ending');
      expect(getChapterTitleForSkipType('mixed-op')).toBe('Mixed Opening');
      expect(getChapterTitleForSkipType('mixed-ed')).toBe('Mixed Ending');
      expect(getChapterTitleForSkipType('recap')).toBe('Recap');
      expect(getChapterTitleForSkipType('preview')).toBe('Preview');
      expect(getChapterTitleForSkipType('custom')).toBe('Custom');
    });

    it('should generate valid Matroska XML chapters with segments', () => {
      const skips = [
        {
          interval: { startTime: 90.0, endTime: 180.0 },
          skipType: 'op',
        },
        {
          interval: { startTime: 1200.0, endTime: 1290.0 },
          skipType: 'ed',
        },
      ];
      const xml = generateMatroskaChaptersXml(skips, 1400.0);

      expect(xml).toContain('<Chapters>');
      expect(xml).toContain('<ChapterString>Prologue</ChapterString>');
      expect(xml).toContain('<ChapterString>Opening</ChapterString>');
      expect(xml).toContain('<ChapterString>Episode Part 1</ChapterString>');
      expect(xml).toContain('<ChapterString>Ending</ChapterString>');
      expect(xml).toContain('<ChapterString>Preview / Epilogue</ChapterString>');
    });

    it('should extract episode info from various filename patterns', () => {
      expect(extractEpisodeInfo('Show.S02E14.1080p.mkv')).toEqual({ season: 2, episode: 14 });
      expect(extractEpisodeInfo('Show.2x05.mkv')).toEqual({ season: 2, episode: 5 });
      expect(extractEpisodeInfo('[Group] Anime Title - EP08 [1080p].mkv')).toEqual({ episode: 8 });
      expect(extractEpisodeInfo('[Group] Anime Title - 12 (1080p).mkv')).toEqual({ episode: 12 });
      const frierenEp = 'Frieren - Beyond Journey\'s End (2023) - S01E28 - It Would Be Embarrassing When We Met Again'
        + ' [HDTV-1080p][AAC 2.0][h265].mkv';
      expect(extractEpisodeInfo(frierenEp)).toEqual({ season: 1, episode: 28 });
      expect(extractEpisodeInfo('Show - S01E05 - 005 - Clean Title.mkv')).toEqual({ season: 1, episode: 5 });
      expect(extractEpisodeInfo('NoEpisodeInfoHere.mkv')).toEqual({});
    });

    describe('extractMalIdFromFilename', () => {
      it('should extract MAL ID from filename or path containing MAL tag', () => {
        const testPath = '/anime/[SubsPlease] Sousou no Frieren - 05 [mal-52991] (1080p).mkv';
        expect(extractMalIdFromFilename(testPath)).toBe(52991);
        expect(extractMalIdFromFilename('Anime Title [malid-12345] S01E01.mkv')).toBe(12345);
        expect(extractMalIdFromFilename('Anime Title {mal:67890} - 01.mkv')).toBe(67890);
        expect(extractMalIdFromFilename('Anime Title myanimelist_1111 - 01.mkv')).toBe(1111);
      });

      it('should return undefined when no MAL ID exists in filename or path', () => {
        const tvdbOnlyPath = '/anime/Frieren [tvdbid-424536]/Season 01/Frieren - S01E28.mkv';
        expect(extractMalIdFromFilename(tvdbOnlyPath)).toBeUndefined();
        expect(extractMalIdFromFilename('Random_Movie.mkv')).toBeUndefined();
      });
    });

    describe('extractTvdbIdFromFilename', () => {
      it('should extract TVDB ID from filename or folder path', () => {
        const fullPath = "Frieren - Beyond Journey's End (2023) [tvdbid-424536]/Season 01/"
          + "Frieren - Beyond Journey's End (2023) - S01E28 - It Would Be Embarrassing When We Met Again "
          + '[HDTV-1080p][AAC 2.0][h265].mkv';
        expect(extractTvdbIdFromFilename(fullPath)).toBe(424536);
        expect(extractTvdbIdFromFilename('/media/Anime [tvdb-12345]/Episode 01.mkv')).toBe(12345);
        expect(extractTvdbIdFromFilename('Anime {tvdbid:98765}.mkv')).toBe(98765);
        expect(extractTvdbIdFromFilename('Anime tvdb_55555.mkv')).toBe(55555);
      });

      it('should return undefined when no TVDB ID exists in filename or path', () => {
        expect(extractTvdbIdFromFilename('/anime/Frieren [mal-52991]/Season 01/Frieren - S01E28.mkv')).toBeUndefined();
        expect(extractTvdbIdFromFilename('Random_Movie.mkv')).toBeUndefined();
      });
    });

    describe('extractIdsFromFilename', () => {
      it('should extract combined IDs from filename', () => {
        expect(extractIdsFromFilename('[tvdb-12345] [mal-6789] [anilist-999]')).toEqual({
          tvdbId: 12345,
          malId: 6789,
          anilistId: 999,
        });
        expect(extractIdsFromFilename('{tvdbid:45678} myanimelist_1111')).toEqual({
          tvdbId: 45678,
          malId: 1111,
        });
      });
    });

    it('should detect existing chapters correctly via hasExistingChapters', () => {
      // 1. ffProbeData chapters
      const fileWithFfprobe = {
        ffProbeData: {
          chapters: [{ id: 0, start_time: '0.000000', end_time: '90.000000' }],
        },
      } as unknown as IFileObject;
      expect(hasExistingChapters(fileWithFfprobe)).toBe(true);

      // 2. MediaInfo Menu track
      const fileWithMediaInfoMenu = {
        mediaInfo: {
          track: [
            { '@type': 'General', Duration: '1440.0' },
            { '@type': 'Menu', Chapters: '1' },
          ],
        },
      } as unknown as IFileObject;
      expect(hasExistingChapters(fileWithMediaInfoMenu)).toBe(true);

      // 3. MediaInfo General track MenuCount
      const fileWithMenuCount = {
        mediaInfo: {
          track: [
            { '@type': 'General', MenuCount: '1' },
          ],
        },
      } as unknown as IFileObject;
      expect(hasExistingChapters(fileWithMenuCount)).toBe(true);

      // 4. ExifTool / meta tags
      const fileWithMeta = {
        meta: {
          ChapterCount: 5,
        },
      } as unknown as IFileObject;
      expect(hasExistingChapters(fileWithMeta)).toBe(true);

      // 5. File without chapters
      const fileWithoutChapters = {
        ffProbeData: { chapters: [] },
        mediaInfo: {
          track: [
            { '@type': 'General', MenuCount: '0' },
            { '@type': 'Video' },
          ],
        },
      } as unknown as IFileObject;
      expect(hasExistingChapters(fileWithoutChapters)).toBe(false);
    });

    it('should resolve MAL ID from title using AniList GraphQL API', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          data: {
            Media: {
              id: 154587,
              idMal: 52991,
              title: {
                romaji: 'Sousou no Frieren',
                english: "Frieren: Beyond Journey's End",
              },
            },
          },
        },
      });

      const log = jest.fn();
      const malId = await resolveMalIdFromTitle(mockAxios, 'Sousou no Frieren', log);
      expect(malId).toBe(52991);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://graphql.anilist.co',
        }),
      );
    });

    it('should resolve MAL ID from TVDB ID using Kitsu and AniList', async () => {
      mockAxios
        .mockResolvedValueOnce({
          data: {
            included: [
              {
                type: 'anime',
                attributes: {
                  canonicalTitle: 'Sousou no Frieren',
                },
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            data: {
              Media: {
                idMal: 52991,
              },
            },
          },
        });

      const log = jest.fn();
      const malId = await resolveMalIdFromTvdbId(mockAxios, 410023, log);
      expect(malId).toBe(52991);
    });
  });

  describe('Plugin Execution Flow', () => {
    it('should successfully process files that have MAL ID directly in the filename', async () => {
      baseArgs.inputFileObj._id = '/anime/[SubsPlease] Sousou no Frieren - 05 [mal-52991] (1080p).mkv';
      mockAxios.mockResolvedValueOnce({
        data: {
          found: true,
          results: [
            {
              interval: { startTime: 120.5, endTime: 210.5 },
              skipType: 'op',
              skipId: 'test-op-uuid',
            },
            {
              interval: { startTime: 1300.0, endTime: 1390.0 },
              skipType: 'ed',
              skipId: 'test-ed-uuid',
            },
          ],
        },
      });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(result.outputFileObj).toBe(baseArgs.inputFileObj);
      expect(mockRunCli).toHaveBeenCalledTimes(1);
      expect(baseArgs.jobLog).toHaveBeenCalledWith(
        expect.stringContaining('Extracted MAL ID directly from filename/path: 52991'),
      );
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/v2/skip-times/52991/5'),
        }),
      );
    });

    it('should successfully process files that have only TVDB ID in the folder/filename structure', async () => {
      baseArgs.inputFileObj._id = "Frieren - Beyond Journey's End (2023) [tvdbid-424536]/Season 01/"
        + "Frieren - Beyond Journey's End (2023) - S01E28 - It Would Be Embarrassing When We Met Again "
        + '[HDTV-1080p][AAC 2.0][h265].mkv';

      mockAxios
        // 1. Kitsu mapping lookup for TVDB ID 424536
        .mockResolvedValueOnce({
          data: {
            included: [
              {
                type: 'anime',
                attributes: {
                  canonicalTitle: 'Sousou no Frieren',
                },
              },
            ],
          },
        })
        // 2. AniList GraphQL search with title "Sousou no Frieren"
        .mockResolvedValueOnce({
          data: {
            data: {
              Media: {
                idMal: 52991,
                title: { english: 'Frieren: Beyond Journey\'s End' },
              },
            },
          },
        })
        // 3. AniSkip query with resolved MAL ID 52991 and episode 28
        .mockResolvedValueOnce({
          data: {
            found: true,
            results: [
              {
                interval: { startTime: 90.0, endTime: 180.0 },
                skipType: 'op',
              },
              {
                interval: { startTime: 1250.0, endTime: 1340.0 },
                skipType: 'ed',
              },
            ],
          },
        });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(baseArgs.jobLog).toHaveBeenCalledWith(
        expect.stringContaining('Extracted TVDB ID from filename/path: 424536'),
      );
      expect(baseArgs.jobLog).toHaveBeenCalledWith(
        expect.stringContaining('Extracted Episode Number 28 from filename'),
      );
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/v2/skip-times/52991/28'),
        }),
      );
      expect(mockRunCli).toHaveBeenCalledTimes(1);
    });

    it('should successfully fetch AniSkip times and embed chapters into MKV', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          found: true,
          results: [
            {
              interval: { startTime: 120.5, endTime: 210.5 },
              skipType: 'op',
              skipId: 'test-op-uuid',
            },
            {
              interval: { startTime: 1300.0, endTime: 1390.0 },
              skipType: 'ed',
              skipId: 'test-ed-uuid',
            },
          ],
        },
      });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(result.outputFileObj).toBe(baseArgs.inputFileObj);
      expect(mockRunCli).toHaveBeenCalledTimes(1);
      expect(baseArgs.jobLog).toHaveBeenCalledWith(
        expect.stringContaining('Successfully embedded 2 AniSkip chapters into'),
      );
    });

    it('should handle Sonarr integration to discover title and episode', async () => {
      baseArgs.inputs.use_sonarr = 'true';
      baseArgs.inputs.sonarr_host = 'http://sonarr.local:8989';
      baseArgs.inputs.sonarr_api_key = 'secret_key';
      baseArgs.inputFileObj._id = '/downloads/Sousou.no.Frieren.S01E05.mkv';

      mockAxios
        // Sonarr parse
        .mockResolvedValueOnce({
          data: {
            series: {
              title: 'Frieren: Beyond Journey\'s End',
              tvdbId: 410023,
            },
            parsedEpisodeInfo: {
              episodeNumbers: [5],
            },
          },
        })
        // AniList title search
        .mockResolvedValueOnce({
          data: {
            data: {
              Media: {
                idMal: 52991,
              },
            },
          },
        })
        // AniSkip skip-times
        .mockResolvedValueOnce({
          data: {
            found: true,
            results: [
              {
                interval: { startTime: 90.0, endTime: 180.0 },
                skipType: 'op',
              },
            ],
          },
        });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('http://sonarr.local:8989/api/v3/parse'),
          headers: expect.objectContaining({ 'X-Api-Key': 'secret_key' }),
        }),
      );
    });

    it('should use custom MAL ID and custom episode number when provided', async () => {
      baseArgs.inputs.custom_mal_id = '9999';
      baseArgs.inputs.custom_episode_number = '1';
      baseArgs.inputFileObj._id = '/videos/arbitrary_name.mkv';

      mockAxios.mockResolvedValueOnce({
        data: {
          found: true,
          results: [
            {
              interval: { startTime: 60.0, endTime: 150.0 },
              skipType: 'op',
            },
          ],
        },
      });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/v2/skip-times/9999/1'),
        }),
      );
    });

    it('should route to Output 2 when no skips are found and continue_if_no_skips is true', async () => {
      mockAxios.mockRejectedValueOnce({
        response: { status: 404 },
        message: 'Request failed with status code 404',
      });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(2);
      expect(baseArgs.logOutcome).toHaveBeenCalledWith('No skip times found - continuing flow');
    });

    it('should throw error when no skips are found and continue_if_no_skips is false', async () => {
      baseArgs.inputs.continue_if_no_skips = 'false';
      mockAxios.mockResolvedValueOnce({
        data: {
          found: false,
          results: [],
        },
      });

      await expect(plugin(baseArgs)).rejects.toThrow('No skip times found');
      expect(baseArgs.logOutcome).toHaveBeenCalledWith('Failed: No skip times found');
    });

    it('should route to Output 3 when Anime/MAL ID is not found and continue_if_no_anime_found is true', async () => {
      baseArgs.inputFileObj._id = '/media/UnknownFileWithoutEpisodeOrId.mkv';

      // AniList search fails
      mockAxios.mockResolvedValueOnce({
        data: {
          data: {
            Media: null,
          },
        },
      });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(3);
      expect(baseArgs.logOutcome).toHaveBeenCalledWith('Anime / MAL ID not found - continuing flow');
    });

    it('should throw error when Anime/MAL ID is not found and continue_if_no_anime_found is false', async () => {
      baseArgs.inputs.continue_if_no_anime_found = 'false';
      baseArgs.inputFileObj._id = '/media/UnknownFileWithoutEpisodeOrId.mkv';

      mockAxios.mockResolvedValueOnce({
        data: {
          data: {
            Media: null,
          },
        },
      });

      await expect(plugin(baseArgs)).rejects.toThrow('Could not determine required info');
      expect(baseArgs.logOutcome).toHaveBeenCalledWith('Failed: Anime / MAL ID not found');
    });

    it('should handle non-MKV container files by routing to Output 3 or throwing depending on settings', async () => {
      baseArgs.inputFileObj._id = '/media/video.mp4';
      baseArgs.inputFileObj.container = 'mp4';

      const result = await plugin(baseArgs);
      expect(result.outputNumber).toBe(3);
      expect(baseArgs.logOutcome).toHaveBeenCalledWith('Unsupported container - skipping');

      baseArgs.inputs.continue_if_no_anime_found = 'false';
      await expect(plugin(baseArgs)).rejects.toThrow('mkvpropedit only supports Matroska (.mkv) files');
    });

    it('should handle mkvpropedit warnings gracefully (exit code 1)', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          found: true,
          results: [
            {
              interval: { startTime: 10.0, endTime: 100.0 },
              skipType: 'op',
            },
          ],
        },
      });

      mockRunCli.mockResolvedValueOnce({ cliExitCode: 1 });

      const result = await plugin(baseArgs);
      expect(result.outputNumber).toBe(1);
      expect(baseArgs.jobLog).toHaveBeenCalledWith(
        expect.stringContaining('mkvpropedit completed with warnings.'),
      );
    });

    it('should throw when mkvpropedit fails (exit code 2)', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          found: true,
          results: [
            {
              interval: { startTime: 10.0, endTime: 100.0 },
              skipType: 'op',
            },
          ],
        },
      });

      mockRunCli.mockResolvedValueOnce({ cliExitCode: 2 });

      await expect(plugin(baseArgs)).rejects.toThrow('Running mkvpropedit failed with non-zero exit code');
    });

    it('should skip adding chapters and route to Output 2 if file already contains chapters', async () => {
      baseArgs.inputs.skip_if_chapters_exist = 'true';
      baseArgs.inputFileObj.ffProbeData = {
        chapters: [{ id: 0, start_time: '0.000000', end_time: '90.000000' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(2);
      expect(baseArgs.logOutcome).toHaveBeenCalledWith('Chapters already exist - skipping');
      expect(baseArgs.jobLog).toHaveBeenCalledWith(
        expect.stringContaining("File already contains chapters and 'Skip If Chapters Exist' is enabled"),
      );
      expect(mockAxios).not.toHaveBeenCalled();
      expect(mockRunCli).not.toHaveBeenCalled();
    });

    it('should proceed with adding chapters if chapters exist but skip_if_chapters_exist is false', async () => {
      baseArgs.inputs.skip_if_chapters_exist = 'false';
      baseArgs.inputFileObj.ffProbeData = {
        chapters: [{ id: 0, start_time: '0.000000', end_time: '90.000000' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      mockAxios.mockResolvedValueOnce({
        data: {
          found: true,
          results: [
            {
              interval: { startTime: 90.0, endTime: 180.0 },
              skipType: 'op',
            },
          ],
        },
      });

      const result = await plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(mockRunCli).toHaveBeenCalledTimes(1);
    });
  });
});
