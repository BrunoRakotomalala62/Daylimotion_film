const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 5000;

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const PLAYER_METADATA_URL = 'https://www.dailymotion.com/player/metadata/video';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.dailymotion.com/',
};

async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 30000
    });
    return response.data;
  } catch (error) {
    console.error('Erreur fetch:', error.message);
    throw error;
  }
}

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
    console.error('Erreur metadata pour', videoId, ':', error.message);
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
    console.error('Erreur extraction URLs:', error.message);
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

function parseDurationFromText(durationText) {
  if (!durationText) return 0;
  
  const parts = durationText.split(':').map(p => parseInt(p) || 0);
  
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

async function searchVideos(query, page = 1) {
  const minDurationSeconds = 90 * 60;
  const results = [];
  
  try {
    const searchUrl = `https://www.dailymotion.com/search/${encodeURIComponent(query)}/top-results`;
    console.log('Fetching search page:', searchUrl);
    
    const html = await fetchPage(searchUrl);
    const $ = cheerio.load(html);
    
    const videoIds = new Set();
    
    $('a[href*="/video/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const match = href.match(/\/video\/([a-zA-Z0-9]+)/);
        if (match && match[1]) {
          videoIds.add(match[1]);
        }
      }
    });
    
    const scriptContent = $('script').map((i, el) => $(el).html() || '').get().join('\n');
    
    const xidMatches = scriptContent.match(/"xid"\s*:\s*"([a-zA-Z0-9]+)"/g);
    if (xidMatches) {
      xidMatches.forEach(match => {
        const id = match.match(/"xid"\s*:\s*"([a-zA-Z0-9]+)"/);
        if (id && id[1]) {
          videoIds.add(id[1]);
        }
      });
    }
    
    const videoIdMatches = scriptContent.match(/\/video\/([a-zA-Z0-9]+)/g);
    if (videoIdMatches) {
      videoIdMatches.forEach(match => {
        const id = match.match(/\/video\/([a-zA-Z0-9]+)/);
        if (id && id[1]) {
          videoIds.add(id[1]);
        }
      });
    }
    
    console.log('Found video IDs from HTML:', videoIds.size);
    
    if (videoIds.size === 0) {
      console.log('Trying Dailymotion API...');
      const apiUrl = `https://api.dailymotion.com/videos?search=${encodeURIComponent(query)}&fields=id,title,thumbnail_720_url,thumbnail_480_url,thumbnail_url,duration,owner.screenname&page=${page}&limit=50&sort=relevance`;
      
      try {
        const apiResponse = await axios.get(apiUrl, {
          headers: { 'User-Agent': headers['User-Agent'] },
          timeout: 20000
        });
        
        if (apiResponse.data && apiResponse.data.list) {
          apiResponse.data.list.forEach(video => {
            if (video.id) videoIds.add(video.id);
          });
          console.log('Found video IDs from API:', videoIds.size);
        }
      } catch (apiErr) {
        console.log('API error:', apiErr.message);
      }
    }
    
    const startIdx = (page - 1) * 10;
    const videoIdArray = Array.from(videoIds);
    console.log('Processing videos starting from index:', startIdx);
    
    let processedCount = 0;
    let skippedCount = 0;
    
    for (const videoId of videoIdArray) {
      if (results.length >= 10) break;
      
      try {
        const metadata = await getVideoMetadata(videoId);
        
        if (metadata) {
          const duration = metadata.duration || 0;
          
          if (duration >= minDurationSeconds) {
            const { url_360p, url_720p } = extractVideoUrls(metadata);
            
            results.push({
              titre: metadata.title || 'Sans titre',
              image_url: metadata.poster_url || metadata.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${videoId}`,
              video_url_360p: url_360p || null,
              video_url_720p: url_720p || null,
              video_id: videoId,
              duree: formatDuration(duration),
              duree_secondes: duration,
              qualites_disponibles: [url_360p ? '360p' : null, url_720p ? '720p' : null].filter(Boolean),
              page_url: `https://www.dailymotion.com/video/${videoId}`
            });
            
            console.log(`Video trouvée: ${metadata.title?.substring(0, 50)}... (${formatDuration(duration)})`);
            processedCount++;
          } else {
            skippedCount++;
          }
        }
      } catch (e) {
        console.log(`Erreur vidéo ${videoId}:`, e.message);
      }
    }
    
    console.log(`Résultats: ${results.length} vidéos longues trouvées, ${skippedCount} vidéos trop courtes`);
    
    return {
      videos: results,
      hasNextPage: videoIdArray.length > (startIdx + 10),
      totalCount: results.length,
      page: page
    };
    
  } catch (error) {
    console.error('Erreur recherche:', error.message);
    return {
      videos: results,
      hasNextPage: false,
      totalCount: 0,
      page: page
    };
  }
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

app.get('/', (req, res) => {
  res.json({
    message: 'Dailymotion Scraper API',
    description: 'API pour rechercher des vidéos Dailymotion de longue durée (1h30+) en qualité 360p ou 720p',
    endpoints: {
      recherche: {
        url: 'GET /recherche?video=QUERY&page=1',
        description: 'Recherche des vidéos par mot-clé avec pagination'
      },
      video: {
        url: 'GET /video/:id',
        description: 'Récupère les informations d\'une vidéo spécifique'
      }
    },
    exemple: '/recherche?video=Jackie chan film&page=1',
    filtres: {
      duree_minimum: '1h30 (90 minutes)',
      qualites: ['360p (basse qualité)', '720p (haute qualité)']
    }
  });
});

app.get('/recherche', async (req, res) => {
  try {
    const { video, page = 1 } = req.query;
    
    if (!video) {
      return res.status(400).json({
        erreur: 'Le paramètre video est requis',
        exemple: '/recherche?video=Jackie chan film&page=1'
      });
    }
    
    const pageNum = parseInt(page) || 1;
    console.log(`\n=== Nouvelle recherche ===`);
    console.log(`Recherche: "${video}" - Page: ${pageNum}`);
    
    const result = await searchVideos(video, pageNum);
    
    res.json({
      recherche: video,
      page: pageNum,
      total_resultats: result.videos.length,
      page_suivante: result.hasNextPage,
      filtre: 'Durée minimum 1h30 (90 minutes)',
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`API disponible sur http://0.0.0.0:${PORT}`);
});

module.exports = app;
