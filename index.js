const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cluster = require('cluster');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 2006;
const WORKERS = process.env.WORKERS || os.cpus().length;

// Performance optimizations
app.use(express.json({ limit: '10mb' }));
app.use(express.static('downloads', {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

// Enable compression
const compression = require('compression');
app.use(compression());

// Rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Cache for video info to avoid repeated API calls
const videoInfoCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Optimized filename sanitization
function sanitizeFilename(filename) {
    return filename
        .replace(/[^\w\s-]/g, '')
        .replace(/[-\s]+/g, '_')
        .toLowerCase()
        .substring(0, 100); // Limit length
}

// Enhanced cleanup with better performance
function cleanUpOldFiles() {
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        const cleanupPromises = files.map(file => {
            return new Promise((resolve) => {
                const filePath = path.join(downloadsDir, file);
                fs.stat(filePath, (err, stats) => {
                    if (!err && now - stats.mtime.getTime() > maxAge) {
                        fs.unlink(filePath, () => resolve());
                    } else {
                        resolve();
                    }
                });
            });
        });
        
        Promise.all(cleanupPromises);
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Get cached video info or fetch new
async function getCachedVideoInfo(videoUrl, videoId) {
    const cacheKey = videoId;
    const cached = videoInfoCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    
    const videoInfo = await ytdl.getInfo(videoUrl, {
        requestOptions: {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        }
    });
    
    videoInfoCache.set(cacheKey, {
        data: videoInfo,
        timestamp: Date.now()
    });
    
    // Clean cache if it gets too large
    if (videoInfoCache.size > 1000) {
        const oldestKey = videoInfoCache.keys().next().value;
        videoInfoCache.delete(oldestKey);
    }
    
    return videoInfo;
}

// Validate YouTube URL/ID
function validateVideoId(videoId) {
    const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
    return videoIdRegex.test(videoId);
}

// NEW: Direct download link endpoint (fastest)
app.get('/direct-link/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const quality = req.query.quality || 'highestaudio';
        
        if (!validateVideoId(videoId)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube video ID format' 
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Get video info from cache or fetch
        const videoInfo = await getCachedVideoInfo(videoUrl, videoId);
        
        // Get the best audio format
        const audioFormats = ytdl.filterFormats(videoInfo.formats, 'audioonly');
        
        if (audioFormats.length === 0) {
            return res.status(400).json({ 
                error: 'No audio formats available for this video' 
            });
        }

        // Find the best quality format
        const bestFormat = audioFormats.reduce((best, current) => {
            const bestBitrate = parseInt(best.audioBitrate) || 0;
            const currentBitrate = parseInt(current.audioBitrate) || 0;
            return currentBitrate > bestBitrate ? current : best;
        });

        res.json({
            status: 'success',
            videoId: videoId,
            title: videoInfo.videoDetails.title,
            author: videoInfo.videoDetails.author.name,
            duration: videoInfo.videoDetails.lengthSeconds,
            directUrl: bestFormat.url,
            format: {
                container: bestFormat.container,
                codecs: bestFormat.codecs,
                bitrate: bestFormat.audioBitrate,
                sampleRate: bestFormat.audioSampleRate
            },
            expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), // 6 hours
            note: 'Use this URL directly in your media player or download client'
        });

    } catch (error) {
        console.error('Direct link error:', error);
        res.status(500).json({ 
            error: 'Failed to get direct link',
            details: error.message 
        });
    }
});

// Optimized streaming download endpoint
app.get('/download-mp3/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const quality = req.query.quality || 'highestaudio';
        const bitrate = req.query.bitrate || '128';

        if (!validateVideoId(videoId)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube video ID format' 
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`Starting download: ${videoUrl}`);

        // Get video info from cache
        const videoInfo = await getCachedVideoInfo(videoUrl, videoId);
        const videoTitle = videoInfo.videoDetails.title;
        const sanitizedTitle = sanitizeFilename(videoTitle);

        console.log(`Video found: ${videoTitle}`);

        // Set optimized response headers
        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Disposition': `attachment; filename="${sanitizedTitle}.mp3"`,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Get audio formats
        const audioFormats = ytdl.filterFormats(videoInfo.formats, 'audioonly');
        
        if (audioFormats.length === 0) {
            return res.status(400).json({ 
                error: 'No audio formats available' 
            });
        }

        // Create optimized stream
        const stream = ytdl(videoUrl, {
            quality: 'highestaudio',
            filter: 'audioonly',
            highWaterMark: 1024 * 512, // 512KB buffer
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }
        });

        // Optimized FFmpeg settings for speed
        const ffmpegProcess = ffmpeg(stream)
            .audioBitrate(parseInt(bitrate))
            .audioChannels(2)
            .audioFrequency(44100)
            .format('mp3')
            .audioCodec('libmp3lame')
            .outputOptions([
                '-preset', 'ultrafast',
                '-threads', '0', // Use all available threads
                '-ac', '2'
            ])
            .on('start', (commandLine) => {
                console.log('FFmpeg started with optimizations');
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    console.log(`Progress: ${Math.round(progress.percent)}%`);
                }
            })
            .on('error', (error) => {
                console.error('FFmpeg error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ 
                        error: 'Conversion failed',
                        details: error.message 
                    });
                }
            })
            .on('end', () => {
                console.log('Conversion completed');
            });

        // Handle client disconnect
        req.on('close', () => {
            ffmpegProcess.kill('SIGKILL');
            console.log('Client disconnected, stopping conversion');
        });

        ffmpegProcess.pipe(res);

    } catch (error) {
        console.error('Download error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Download failed',
                details: error.message 
            });
        }
    }
});

// Optimized batch download endpoint
app.post('/batch-download', async (req, res) => {
    try {
        const { videoIds, quality = 'highestaudio', bitrate = '128' } = req.body;
        
        if (!Array.isArray(videoIds) || videoIds.length === 0) {
            return res.status(400).json({ 
                error: 'videoIds array is required' 
            });
        }

        if (videoIds.length > 10) {
            return res.status(400).json({ 
                error: 'Maximum 10 videos per batch' 
            });
        }

        const results = await Promise.allSettled(
            videoIds.map(async (videoId) => {
                if (!validateVideoId(videoId)) {
                    throw new Error(`Invalid video ID: ${videoId}`);
                }
                
                const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                const videoInfo = await getCachedVideoInfo(videoUrl, videoId);
                const sanitizedTitle = sanitizeFilename(videoInfo.videoDetails.title);
                const uniqueId = uuidv4().substring(0, 8);
                const filename = `${sanitizedTitle}_${uniqueId}.mp3`;
                
                return {
                    videoId,
                    title: videoInfo.videoDetails.title,
                    filename,
                    downloadUrl: `/downloads/${filename}`,
                    status: 'queued'
                };
            })
        );

        const successful = results
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value);
        
        const failed = results
            .filter(result => result.status === 'rejected')
            .map((result, index) => ({
                videoId: videoIds[index],
                error: result.reason.message
            }));

        res.json({
            status: 'batch_queued',
            successful,
            failed,
            total: videoIds.length
        });

    } catch (error) {
        res.status(500).json({ 
            error: 'Batch processing failed',
            details: error.message 
        });
    }
});

// Enhanced video info endpoint with caching
app.get('/video-info/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        if (!validateVideoId(videoId)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube video ID format' 
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const videoInfo = await getCachedVideoInfo(videoUrl, videoId);
        
        res.json({
            videoId,
            title: videoInfo.videoDetails.title,
            author: videoInfo.videoDetails.author.name,
            duration: videoInfo.videoDetails.lengthSeconds,
            viewCount: videoInfo.videoDetails.viewCount,
            description: videoInfo.videoDetails.description?.substring(0, 300) + '...',
            thumbnails: videoInfo.videoDetails.thumbnails,
            uploadDate: videoInfo.videoDetails.uploadDate,
            category: videoInfo.videoDetails.category,
            cached: videoInfoCache.has(videoId)
        });
    } catch (error) {
        res.status(404).json({ 
            error: 'Video not found',
            details: error.message 
        });
    }
});

app.get('/formats/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        if (!validateVideoId(videoId)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube video ID format' 
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const videoInfo = await getCachedVideoInfo(videoUrl, videoId);
        
        const audioFormats = ytdl.filterFormats(videoInfo.formats, 'audioonly');
        const videoFormats = ytdl.filterFormats(videoInfo.formats, 'videoonly');
        
        const audioInfo = audioFormats.map(format => ({
            itag: format.itag,
            container: format.container,
            codecs: format.codecs,
            bitrate: format.audioBitrate,
            sampleRate: format.audioSampleRate,
            channels: format.audioChannels,
            size: format.contentLength
        }));

        const videoInfo_formats = videoFormats.slice(0, 10).map(format => ({
            itag: format.itag,
            container: format.container,
            qualityLabel: format.qualityLabel,
            fps: format.fps,
            bitrate: format.bitrate,
            size: format.contentLength
        }));

        res.json({
            videoId,
            videoTitle: videoInfo.videoDetails.title,
            audioFormats: audioInfo,
            videoFormats: videoInfo_formats,
            recommendedAudio: audioInfo[0] || null
        });
    } catch (error) {
        res.status(404).json({ 
            error: 'Video not found',
            details: error.message 
        });
    }
});

// Health check with performance metrics
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'YouTube to MP3 Converter API v2.0',
        uptime: process.uptime(),
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
        },
        cache: {
            videoInfoCacheSize: videoInfoCache.size
        },
        performance: 'optimized'
    });
});

// Cache statistics endpoint
app.get('/cache-stats', (req, res) => {
    res.json({
        videoInfoCache: {
            size: videoInfoCache.size,
            maxSize: 1000,
            entries: Array.from(videoInfoCache.keys()).slice(0, 10)
        }
    });
});

// Clear cache endpoint (admin)
app.post('/clear-cache', (req, res) => {
    videoInfoCache.clear();
    res.json({ 
        status: 'Cache cleared',
        timestamp: new Date().toISOString()
    });
});

// Clean up old files every 30 minutes instead of hourly
setInterval(cleanUpOldFiles, 30 * 60 * 1000);

// Enhanced error handling
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: 'Something went wrong on the server'
    });
});

// Enhanced 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        availableEndpoints: {
            'GET /direct-link/:videoId': 'Get direct download URL (fastest)',
            'GET /download-mp3/:videoId': 'Stream download MP3',
            'POST /batch-download': 'Batch download multiple videos',
            'GET /video-info/:videoId': 'Get video information (cached)',
            'GET /formats/:videoId': 'List available formats',
            'GET /health': 'Health check with metrics',
            'GET /cache-stats': 'Cache statistics',
            'POST /clear-cache': 'Clear info cache'
        }
    });
});

if (cluster.isMaster && process.env.NODE_ENV === 'production') {
    console.log(`Master ${process.pid} is running`);
    console.log(`Starting ${WORKERS} workers...`);
    
    for (let i = 0; i < WORKERS; i++) {
        cluster.fork();
    }
    
    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
        cluster.fork();
    });
} else {
    app.listen(PORT, () => {
        console.log(`🚀 Optimized YouTube to MP3 API running on port ${PORT}`);
        console.log(`📁 Downloads directory: ${downloadsDir}`);
        console.log(`🔗 Health check: http://localhost:${PORT}/health`);
        console.log(`⚡ Direct links: http://localhost:${PORT}/direct-link/{videoId}`);
        console.log(`🎵 Stream download: http://localhost:${PORT}/download-mp3/{videoId}`);
        if (cluster.worker) {
            console.log(`👷 Worker ${cluster.worker.id} (PID: ${process.pid})`);
        }
    });
}

module.exports = app;