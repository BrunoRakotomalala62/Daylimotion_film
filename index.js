const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 5000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.API_URL;

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const PLAYER_METADATA_URL = 'https://www.dailymotion.com/player/metadata/video';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function getVideoMetadata(videoId) {
  try {
    const metadataUrl = `${PLAYER_METADATA_URL}/${videoId}`;
    const response = await axios.get(metadataUrl, {
      headers: {
        'User-Agent': headers['User-Agent'],
        'Referer': `https://www.dailymotion.com/video/${videoId}`,
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    return null;
  }
}

function extractVideoUrls(metadata) {
  try {
    if (!metadata || !metadata.qualities) {
      return { url_360p: null, url_720p: null };
    }
    
    const qualities = metadata.qualities;
    let url_360p = null;
    let url_720p = null;
    
    if (qualities['360'] && qualities['360'].length > 0) {
      for (const q of qualities['360']) {
        if (q.type === 'video/mp4' || q.url) {
          url_360p = q.url;
          break;
        }
      }
    }
    
    if (qualities['720'] && qualities['720'].length > 0) {
      for (const q of qualities['720']) {
        if (q.type === 'video/mp4' || q.url) {
          url_720p = q.url;
          break;
        }
      }
    }
    
    if (!url_360p && qualities['240'] && qualities['240'].length > 0) {
      for (const q of qualities['240']) {
        if (q.type === 'video/mp4' || q.url) {
          url_360p = q.url;
          break;
        }
      }
    }
    
    if (!url_720p && qualities['480'] && qualities['480'].length > 0) {
      for (const q of qualities['480']) {
        if (q.type === 'video/mp4' || q.url) {
          url_720p = q.url;
          break;
        }
      }
    }
    
    if (!url_360p && !url_720p && qualities['auto'] && qualities['auto'].length > 0) {
      url_360p = qualities['auto'][0].url;
      url_720p = qualities['auto'][0].url;
    }
    
    return { url_360p, url_720p };
  } catch (error) {
    return { url_360p: null, url_720p: null };
  }
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}h${minutes.toString().padStart(2, '0')}m${secs.toString().padStart(2, '0')}s`;
  }
  return `${minutes}m${secs.toString().padStart(2, '0')}s`;
}

async function searchVideos(query, page = 1, minResults = 15, minDurationMinutes = 60) {
  const minDurationSeconds = minDurationMinutes * 60;
  const results = [];
  const seenIds = new Set();
  
  console.log(`\n=== Recherche: "${query}" - Page: ${page} - Durée min: ${minDurationMinutes}min ===`);
  
  // Stratégies de recherche multiples pour trouver plus de résultats
  const searchStrategies = [
    { sort: 'relevance', longer: 1 },
    { sort: 'visited', longer: 1 },
    { sort: 'recent', longer: 1 },
    { sort: 'relevance', longer: 0 }
  ];
  
  let currentApiPage = (page - 1) * 3 + 1;
  let maxApiPages = currentApiPage + 15;
  let hasMore = true;
  let totalAvailable = 0;
  let strategyIndex = 0;
  
  while (results.length < minResults && currentApiPage <= maxApiPages && (hasMore || strategyIndex < searchStrategies.length)) {
    const strategy = searchStrategies[strategyIndex % searchStrategies.length];
    
    try {
      // Utilisation de l'API avec paramètre longer_than pour les films
      const apiUrl = `https://api.dailymotion.com/videos?search=${encodeURIComponent(query)}&fields=id,title,thumbnail_720_url,thumbnail_480_url,thumbnail_url,duration,owner.screenname,views_total&page=${currentApiPage}&limit=100&sort=${strategy.sort}${strategy.longer ? '&longer_than=20' : ''}`;
      
      console.log(`Fetching API page ${currentApiPage} (${strategy.sort})...`);
      
      const response = await axios.get(apiUrl, {
        headers: { 'User-Agent': headers['User-Agent'] },
        timeout: 20000
      });
      
      if (response.data && response.data.list) {
        const allVideos = response.data.list;
        totalAvailable = Math.max(totalAvailable, response.data.total || 0);
        hasMore = response.data.has_more || false;
        
        console.log(`Page ${currentApiPage}: ${allVideos.length} videos, total available: ${totalAvailable}`);
        
        // Filtrer les vidéos selon la durée minimum demandée
        const longVideos = allVideos.filter(v => v.duration >= minDurationSeconds && !seenIds.has(v.id));
        console.log(`Videos >= ${minDurationMinutes}min on this page: ${longVideos.length}`);
        
        // Trier par durée décroissante pour prioriser les films complets
        longVideos.sort((a, b) => b.duration - a.duration);
        
        for (const video of longVideos) {
          if (results.length >= minResults) break;
          if (seenIds.has(video.id)) continue;
          seenIds.add(video.id);
          
          try {
            const metadata = await getVideoMetadata(video.id);
            const { url_360p, url_720p } = extractVideoUrls(metadata);
            
            results.push({
              titre: video.title || 'Sans titre',
              image_url: video.thumbnail_720_url || video.thumbnail_480_url || video.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${video.id}`,
              video_url_360p: url_360p || null,
              video_url_720p: url_720p || null,
              video_id: video.id,
              duree: formatDuration(video.duration),
              duree_secondes: video.duration,
              qualites_disponibles: [url_360p ? '360p' : null, url_720p ? '720p' : null].filter(Boolean),
              chaine: video['owner.screenname'] || '',
              vues: video.views_total || 0,
              page_url: `https://www.dailymotion.com/video/${video.id}`
            });
            
            console.log(`+ [${results.length}] ${video.title?.substring(0, 50)}... (${formatDuration(video.duration)})`);
          } catch (err) {
            console.log('Erreur video:', video.id);
          }
        }
      } else {
        hasMore = false;
      }
      
      currentApiPage++;
      
      // Si pas assez de résultats et plus de pages, essayer une autre stratégie
      if (!hasMore && results.length < minResults) {
        strategyIndex++;
        currentApiPage = 1;
        hasMore = true;
      }
      
    } catch (error) {
      console.error('API error:', error.message);
      strategyIndex++;
      currentApiPage = 1;
      hasMore = true;
    }
  }
  
  // Trier les résultats finaux par durée décroissante
  results.sort((a, b) => b.duree_secondes - a.duree_secondes);
  
  console.log(`\nTotal résultats: ${results.length} vidéos >= ${minDurationMinutes}min trouvées`);
  
  return {
    videos: results,
    hasNextPage: hasMore || results.length >= minResults,
    totalCount: totalAvailable,
    page: page,
    minDuration: minDurationMinutes
  };
}

async function getVideoInfo(videoId) {
  try {
    const metadata = await getVideoMetadata(videoId);
    
    if (!metadata) {
      throw new Error('Impossible de récupérer les métadonnées de la vidéo');
    }
    
    const { url_360p, url_720p } = extractVideoUrls(metadata);
    
    return {
      titre: metadata.title || 'Sans titre',
      image_url: metadata.poster_url || metadata.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${videoId}`,
      video_url_360p: url_360p || null,
      video_url_720p: url_720p || null,
      video_id: videoId,
      duree: formatDuration(metadata.duration || 0),
      duree_secondes: metadata.duration || 0,
      qualites_disponibles: [url_360p ? '360p' : null, url_720p ? '720p' : null].filter(Boolean),
      page_url: `https://www.dailymotion.com/video/${videoId}`,
      description: metadata.description || ''
    };
  } catch (error) {
    console.error('Erreur video info:', error.message);
    throw error;
  }
}

async function proxyStream(url, res, videoId, quality) {
  try {
    console.log('Proxying stream:', url);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': headers['User-Agent'],
        'Referer': 'https://www.dailymotion.com/',
        'Origin': 'https://www.dailymotion.com',
      },
      responseType: 'text',
      timeout: 30000
    });
    
    let m3u8Content = response.data;
    
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    
    const lines = m3u8Content.split('\n');
    const modifiedLines = lines.map(line => {
      if (line && !line.startsWith('#') && line.trim() !== '') {
        if (line.startsWith('http')) {
          return `/proxy?url=${encodeURIComponent(line.trim())}`;
        } else {
          return `/proxy?url=${encodeURIComponent(baseUrl + line.trim())}`;
        }
      }
      return line;
    });
    
    m3u8Content = modifiedLines.join('\n');
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}_${quality}p.m3u8"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    return res.send(m3u8Content);
    
  } catch (error) {
    console.error('Proxy stream error:', error.message);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    message: 'Dailymotion Scraper API',
    description: 'API pour rechercher des vidéos Dailymotion de longue durée (films) en qualité 360p ou 720p',
    endpoints: {
      recherche: {
        url: 'GET /recherche?video=QUERY&page=1&duree_min=60&limit=15',
        description: 'Recherche des vidéos par mot-clé avec pagination et filtrage par durée',
        parametres: {
          video: 'Terme de recherche (obligatoire)',
          page: 'Numéro de page (défaut: 1)',
          duree_min: 'Durée minimum en minutes (défaut: 60)',
          limit: 'Nombre de résultats max (défaut: 15, max: 30)'
        }
      },
      video: {
        url: 'GET /video/:id',
        description: 'Récupère les informations d\'une vidéo spécifique'
      },
      telecharger: {
        url: 'GET /telecharger/:videoId?quality=720',
        description: 'TELECHARGE LE FILM COMPLET EN MP4 (peut prendre plusieurs minutes)',
        exemple: '/telecharger/x8fme0n?quality=360',
        qualites: ['360 = basse qualité, fichier plus petit', '720 = haute qualité, fichier plus gros']
      },
      stream: {
        url: 'GET /stream/:videoId?quality=720',
        description: 'Stream HLS pour lecteurs vidéo (VLC, MX Player)',
        exemple: '/stream/x8fme0n?quality=360'
      },
      health: {
        url: 'GET /health',
        description: 'Vérification de l\'état de l\'API (utilisé pour le keep-alive)'
      }
    },
    exemples: [
      '/recherche?video=Film gasy&page=1',
      '/recherche?video=Film gasy&duree_min=60',
      '/recherche?video=Jackie chan film&duree_min=90&limit=20'
    ],
    filtres: {
      duree_minimum: '60 minutes (configurable avec duree_min)',
      qualites: ['360p (basse qualité)', '720p (haute qualité)']
    }
  });
});

app.get('/recherche', async (req, res) => {
  try {
    const { video, page = 1, duree_min = 60, limit = 15 } = req.query;
    
    if (!video) {
      return res.status(400).json({
        erreur: 'Le paramètre video est requis',
        exemple: '/recherche?video=Film gasy&page=1&duree_min=60',
        parametres: {
          video: 'Terme de recherche (obligatoire)',
          page: 'Numéro de page (défaut: 1)',
          duree_min: 'Durée minimum en minutes (défaut: 60)',
          limit: 'Nombre de résultats max (défaut: 15)'
        }
      });
    }
    
    const pageNum = parseInt(page) || 1;
    const minDuration = parseInt(duree_min) || 60;
    const maxResults = Math.min(parseInt(limit) || 15, 30);
    
    const result = await searchVideos(video, pageNum, maxResults, minDuration);
    
    res.json({
      recherche: video,
      page: pageNum,
      total_resultats: result.videos.length,
      total_disponible: result.totalCount,
      page_suivante: result.hasNextPage,
      filtre: `Durée minimum ${minDuration} minutes`,
      qualites: ['360p', '720p'],
      resultats: result.videos
    });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      erreur: 'Erreur lors de la recherche',
      message: error.message
    });
  }
});

app.get('/video/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({
        erreur: 'ID de vidéo requis'
      });
    }
    
    const videoInfo = await getVideoInfo(id);
    
    res.json({
      succes: true,
      video: videoInfo
    });
    
  } catch (error) {
    res.status(500).json({
      erreur: 'Erreur lors de la récupération de la vidéo',
      message: error.message
    });
  }
});

app.get('/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ erreur: 'URL requise' });
    }
    
    const targetUrl = decodeURIComponent(url);
    console.log('Proxying:', targetUrl.substring(0, 80) + '...');
    
    if (targetUrl.includes('.m3u8')) {
      const response = await axios.get(targetUrl, {
        headers: {
          'User-Agent': headers['User-Agent'],
          'Referer': 'https://www.dailymotion.com/',
          'Origin': 'https://www.dailymotion.com',
        },
        responseType: 'text',
        timeout: 30000
      });
      
      let m3u8Content = response.data;
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      
      const lines = m3u8Content.split('\n');
      const modifiedLines = lines.map(line => {
        if (line && !line.startsWith('#') && line.trim() !== '') {
          let absoluteUrl;
          if (line.startsWith('http')) {
            absoluteUrl = line.trim();
          } else if (line.startsWith('../')) {
            const urlParts = baseUrl.split('/');
            let relativeParts = line.trim().split('/');
            let upCount = 0;
            while (relativeParts[0] === '..') {
              upCount++;
              relativeParts.shift();
            }
            const newBase = urlParts.slice(0, -1 - upCount).join('/') + '/';
            absoluteUrl = newBase + relativeParts.join('/');
          } else {
            absoluteUrl = baseUrl + line.trim();
          }
          return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
        }
        return line;
      });
      
      m3u8Content = modifiedLines.join('\n');
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(m3u8Content);
    }
    
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': headers['User-Agent'],
        'Referer': 'https://www.dailymotion.com/',
        'Origin': 'https://www.dailymotion.com',
      },
      responseType: 'stream',
      timeout: 120000
    });
    
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    response.data.pipe(res);
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({
      erreur: 'Erreur proxy',
      message: error.message
    });
  }
});

app.get('/download', async (req, res) => {
  try {
    const { video } = req.query;
    
    if (!video) {
      return res.status(400).json({
        erreur: 'Le paramètre video (URL) est requis',
        exemple: '/download?video=URL_VIDEO_360p_ou_720p',
        note: 'Utilisez l\'URL video_url_360p ou video_url_720p obtenue depuis /recherche'
      });
    }
    
    const videoUrl = decodeURIComponent(video);
    console.log('Download request for:', videoUrl);
    
    const videoIdMatch = videoUrl.match(/video\/([a-zA-Z0-9]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : 'video';
    
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': headers['User-Agent'],
        'Referer': 'https://www.dailymotion.com/',
        'Origin': 'https://www.dailymotion.com',
      },
      responseType: 'text',
      timeout: 30000
    });
    
    let m3u8Content = response.data;
    const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf('/') + 1);
    
    const lines = m3u8Content.split('\n');
    const modifiedLines = lines.map(line => {
      if (line && !line.startsWith('#') && line.trim() !== '') {
        if (line.startsWith('http')) {
          return `/proxy?url=${encodeURIComponent(line.trim())}`;
        } else {
          return `/proxy?url=${encodeURIComponent(baseUrl + line.trim())}`;
        }
      }
      return line;
    });
    
    m3u8Content = modifiedLines.join('\n');
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.m3u8"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    return res.send(m3u8Content);
    
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({
      erreur: 'Erreur lors du téléchargement',
      message: error.message
    });
  }
});

app.get('/stream/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality = '720' } = req.query;
    
    if (!videoId) {
      return res.status(400).json({
        erreur: 'ID de vidéo requis'
      });
    }
    
    console.log(`Stream request for video ${videoId} at quality ${quality}p`);
    
    const metadata = await getVideoMetadata(videoId);
    if (!metadata) {
      return res.status(404).json({
        erreur: 'Vidéo non trouvée'
      });
    }
    
    const { url_360p, url_720p } = extractVideoUrls(metadata);
    
    let streamUrl = quality === '360' ? url_360p : url_720p;
    if (!streamUrl) {
      streamUrl = url_720p || url_360p;
    }
    
    if (!streamUrl) {
      return res.status(404).json({
        erreur: 'Aucun flux vidéo disponible'
      });
    }
    
    await proxyStream(streamUrl, res, videoId, quality);
    
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(500).json({
      erreur: 'Erreur lors du streaming',
      message: error.message
    });
  }
});

const downloadProgress = new Map();

app.get('/telecharger/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { quality = '720' } = req.query;
    
    if (!videoId) {
      return res.status(400).json({
        erreur: 'ID de vidéo requis',
        exemple: '/telecharger/x8fme0n?quality=360'
      });
    }
    
    console.log(`\n=== Téléchargement MP4: ${videoId} (${quality}p) ===`);
    
    const metadata = await getVideoMetadata(videoId);
    if (!metadata) {
      return res.status(404).json({
        erreur: 'Vidéo non trouvée'
      });
    }
    
    const { url_360p, url_720p } = extractVideoUrls(metadata);
    
    let streamUrl = quality === '360' ? url_360p : url_720p;
    if (!streamUrl) {
      streamUrl = url_720p || url_360p;
    }
    
    if (!streamUrl) {
      return res.status(404).json({
        erreur: 'Aucun flux vidéo disponible'
      });
    }
    
    const title = metadata.title ? metadata.title.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 50) : videoId;
    const filename = `${title}_${quality}p.mp4`;
    
    console.log('Stream URL:', streamUrl.substring(0, 80) + '...');
    console.log('Filename:', filename);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    const ffmpegArgs = [
      '-headers', `User-Agent: ${headers['User-Agent']}\r\nReferer: https://www.dailymotion.com/\r\nOrigin: https://www.dailymotion.com`,
      '-i', streamUrl,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];
    
    console.log('Starting ffmpeg...');
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let totalBytes = 0;
    
    ffmpeg.stdout.on('data', (data) => {
      totalBytes += data.length;
      if (totalBytes % (1024 * 1024) < 65536) {
        console.log(`Downloaded: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);
      }
      res.write(data);
    });
    
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('time=')) {
        const timeMatch = msg.match(/time=(\d{2}:\d{2}:\d{2})/);
        if (timeMatch) {
          console.log(`Progress: ${timeMatch[1]}`);
        }
      }
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`ffmpeg finished with code ${code}, total: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);
      res.end();
    });
    
    ffmpeg.on('error', (err) => {
      console.error('ffmpeg error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ erreur: 'Erreur ffmpeg', message: err.message });
      }
    });
    
    req.on('close', () => {
      console.log('Client disconnected, killing ffmpeg');
      ffmpeg.kill('SIGTERM');
    });
    
  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        erreur: 'Erreur lors du téléchargement',
        message: error.message
      });
    }
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    message: 'API Dailymotion Scraper est en ligne'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`API disponible sur http://0.0.0.0:${PORT}`);
  
  if (RENDER_URL) {
    console.log(`Auto-ping activé pour: ${RENDER_URL}`);
    cron.schedule('*/14 * * * *', async () => {
      try {
        const response = await axios.get(`${RENDER_URL}/health`);
        console.log(`[Auto-ping] ${new Date().toISOString()} - Status: ${response.status}`);
      } catch (error) {
        console.error(`[Auto-ping] Erreur: ${error.message}`);
      }
    });
  } else {
    console.log('Auto-ping désactivé (définir RENDER_EXTERNAL_URL ou API_URL pour activer)');
  }
});

module.exports = app;
