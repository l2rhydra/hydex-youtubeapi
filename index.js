const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('downloads')); // Serve downloaded files

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Helper function to clean up old files (optional)
function cleanUpOldFiles() {
    const files = fs.readdirSync(downloadsDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    files.forEach(file => {
        const filePath = path.join(downloadsDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > maxAge) {
            fs.unlinkSync(filePath);
        }
    });
}

// Main API endpoint
app.post('/download-mp3', async (req, res) => {
    try {
        const { videoId, quality = 'highestaudio' } = req.body;

        if (!videoId) {
            return res.status(400).json({ 
                error: 'Video ID is required',
                example: { videoId: 'dQw4w9WgXcQ' }
            });
        }

        const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
        if (!videoIdRegex.test(videoId)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube video ID format' 
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Fetch video info
        let videoInfo;
        try {
            videoInfo = await ytdl.getInfo(videoUrl);
        } catch (error) {
            return res.status(404).json({ 
                error: 'Video not found or unavailable',
                details: error.message 
            });
        }

        const videoTitle = videoInfo.videoDetails.title;
        const sanitizedTitle = sanitizeFilename(videoTitle);
        const uniqueId = uuidv4().substring(0, 8);
        const outputFileName = `${sanitizedTitle}_${uniqueId}.mp3`;
        const outputPath = path.join(downloadsDir, outputFileName);

        // Stream and convert
        const stream = ytdl(videoUrl, {
            quality,
            filter: 'audioonly'
        });

        ffmpeg(stream)
            .audioBitrate(128)
            .save(outputPath)
            .on('end', () => {
                console.log(`Conversion complete: ${outputFileName}`);
                return res.status(200).json({
                    status: 'completed',
                    videoTitle: videoTitle,
                    filename: outputFileName,
                    downloadUrl: `/downloads/${outputFileName}`
                });
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
                return res.status(500).json({ 
                    error: 'Conversion failed', 
                    details: err.message 
                });
            });

    } catch (error) {
        console.error('Unexpected error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// GET endpoint for simple downloads (alternative method)
app.get('/download-mp3/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const quality = req.query.quality || 'highestaudio';

        if (!videoId) {
            return res.status(400).json({ error: 'Video ID is required' });
        }

        // Validate YouTube video ID format
        const videoIdRegex = /^[a-zA-Z0-9_-]{11}$/;
        if (!videoIdRegex.test(videoId)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube video ID format' 
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        console.log(`Attempting to download: ${videoUrl}`);

        // Check if video exists and get info with retry logic
        let videoInfo;
        let retries = 3;
        
        while (retries > 0) {
            try {
                console.log(`Getting video info, attempts left: ${retries}`);
                videoInfo = await ytdl.getInfo(videoUrl);
                break;
            } catch (error) {
                console.error(`Attempt failed: ${error.message}`);
                retries--;
                if (retries === 0) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
        }

        const videoTitle = videoInfo.videoDetails.title;
        const sanitizedTitle = sanitizeFilename(videoTitle);

        console.log(`Video found: ${videoTitle}`);

        // Set response headers for file download
        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Disposition': `attachment; filename="${sanitizedTitle}.mp3"`,
            'Access-Control-Allow-Origin': '*'
        });

        // Get the best audio format
        const audioFormats = ytdl.filterFormats(videoInfo.formats, 'audioonly');
        
        if (audioFormats.length === 0) {
            return res.status(400).json({ 
                error: 'No audio formats available for this video' 
            });
        }

        console.log(`Found ${audioFormats.length} audio formats`);

        // Create stream with better options
        const stream = ytdl(videoUrl, {
            quality: 'highestaudio',
            filter: 'audioonly',
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        });

        // Handle stream errors
        stream.on('error', (error) => {
            console.error('Stream error:', error);
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Stream error',
                    details: error.message 
                });
            }
        });

        // Convert to MP3 and stream
        const ffmpegProcess = ffmpeg(stream)
            .audioBitrate(128)
            .audioChannels(2)
            .audioFrequency(44100)
            .format('mp3')
            .on('start', (commandLine) => {
                console.log('FFmpeg started:', commandLine);
            })
            .on('progress', (progress) => {
                console.log(`Processing: ${Math.round(progress.percent || 0)}% done`);
            })
            .on('error', (error, stdout, stderr) => {
                console.error('FFmpeg error:', error);
                console.error('FFmpeg stderr:', stderr);
                if (!res.headersSent) {
                    res.status(500).json({ 
                        error: 'Conversion error',
                        details: error.message 
                    });
                }
            })
            .on('end', () => {
                console.log('Conversion completed successfully');
            });

        ffmpegProcess.pipe(res);

    } catch (error) {
        console.error('Error in download endpoint:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal server error',
                details: error.message,
                suggestion: 'Try again in a few moments or check if the video ID is correct'
            });
        }
    }
});

// Status endpoint to check download progress
app.get('/status/:filename', (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(downloadsDir, filename);

    if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        res.json({
            status: 'completed',
            filename: filename,
            size: stats.size,
            downloadUrl: `/downloads/${filename}`,
            createdAt: stats.birthtime
        });
    } else {
        res.json({
            status: 'processing or not found',
            filename: filename
        });
    }
});

// Get video info endpoint
app.get('/video-info/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        const videoInfo = await ytdl.getInfo(videoUrl);
        
        res.json({
            title: videoInfo.videoDetails.title,
            author: videoInfo.videoDetails.author.name,
            duration: videoInfo.videoDetails.lengthSeconds,
            viewCount: videoInfo.videoDetails.viewCount,
            description: videoInfo.videoDetails.description?.substring(0, 200) + '...',
            thumbnails: videoInfo.videoDetails.thumbnails
        });
    } catch (error) {
        res.status(404).json({ 
            error: 'Video not found',
            details: error.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'YouTube to MP3 Converter API'
    });
});

// List available formats for a video
app.get('/formats/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        const videoInfo = await ytdl.getInfo(videoUrl);
        const audioFormats = ytdl.filterFormats(videoInfo.formats, 'audioonly');
        
        const formatsInfo = audioFormats.map(format => ({
            itag: format.itag,
            container: format.container,
            codecs: format.codecs,
            bitrate: format.audioBitrate,
            sampleRate: format.audioSampleRate,
            channels: format.audioChannels
        }));

        res.json({
            videoTitle: videoInfo.videoDetails.title,
            availableAudioFormats: formatsInfo
        });
    } catch (error) {
        res.status(404).json({ 
            error: 'Video not found',
            details: error.message 
        });
    }
});

// Clean up old files periodically
setInterval(cleanUpOldFiles, 60 * 60 * 1000); // Run every hour

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: 'Something went wrong on the server'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        availableEndpoints: {
            'POST /download-mp3': 'Download MP3 with body { videoId: "..." }',
            'GET /download-mp3/:videoId': 'Direct download MP3',
            'GET /video-info/:videoId': 'Get video information',
            'GET /status/:filename': 'Check download status',
            'GET /formats/:videoId': 'List available audio formats',
            'GET /health': 'Health check'
        }
    });
});

app.listen(PORT, () => {
    console.log(`🎵 YouTube to MP3 API server running on port ${PORT}`);
    console.log(`📁 Downloads directory: ${downloadsDir}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;