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

async function fetchPage(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 20000
    });
    return response.data;
  } catch (error) {
    console.error('Erreur fetch:', error.message);
    throw error;
  }
}

function extractVideoInfoFromHtml(html) {
  const $ = cheerio.load(html);
  let videoInfo = null;
  
  $('script').each((i, script) => {
    const content = $(script).html();
    if (content && content.includes('window.videoInfo')) {
      try {
        const match = content.match(/window\.videoInfo\s*=\s*(\{[\s\S]*?\})\s*$/m);
        if (match) {
          videoInfo = JSON.parse(match[1]);
        }
      } catch (e) {
        try {
          const altMatch = content.match(/window\.videoInfo\s*=\s*(\{[^<]+)/);
          if (altMatch) {
            let jsonStr = altMatch[1].trim();
            if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
            videoInfo = JSON.parse(jsonStr);
          }
        } catch (e2) {
          console.log('Parse videoInfo error:', e2.message);
        }
      }
    }
  });
  
  return videoInfo;
}

async function getVideoMetadata(videoId) {
  try {
    const metadataUrl = `${PLAYER_METADATA_URL}/${videoId}`;
    const response = await axios.get(metadataUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error('Erreur metadata:', error.message);
    return null;
  }
}

async function extractVideoUrl(metadata) {
  try {
    if (metadata && metadata.qualities) {
      const qualities = metadata.qualities;
      
      if (qualities['360'] && qualities['360'].length > 0) {
        for (const q of qualities['360']) {
          if (q.type === 'video/mp4' || q.url) {
            return q.url;
          }
        }
      }
      
      if (qualities['240'] && qualities['240'].length > 0) {
        for (const q of qualities['240']) {
          if (q.type === 'video/mp4' || q.url) {
            return q.url;
          }
        }
      }
      
      if (qualities['auto'] && qualities['auto'].length > 0) {
        return qualities['auto'][0].url;
      }
    }
    return null;
  } catch (error) {
    console.error('Erreur extraction URL:', error.message);
    return null;
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

async function searchVideos(query, page = 1) {
  const minDurationSeconds = 90 * 60;
  const results = [];
  
  try {
    const apiUrl = `https://api.dailymotion.com/videos?search=${encodeURIComponent(query)}&fields=id,title,thumbnail_720_url,thumbnail_480_url,thumbnail_url,duration,owner.screenname&page=${page}&limit=100&sort=relevance`;
    
    console.log('Fetching from API:', apiUrl);
    
    const apiResponse = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 20000
    });
    
    console.log('API Response total:', apiResponse.data?.total, 'list length:', apiResponse.data?.list?.length);
    
    if (apiResponse.data && apiResponse.data.list && apiResponse.data.list.length > 0) {
      const longVideos = apiResponse.data.list.filter(video => video.duration >= minDurationSeconds);
      
      console.log('Videos with duration >= 90min:', longVideos.length);
      
      for (const video of longVideos.slice(0, 10)) {
        try {
          const metadata = await getVideoMetadata(video.id);
          const videoUrl = await extractVideoUrl(metadata);
          
          results.push({
            titre: video.title || 'Sans titre',
            image_url: video.thumbnail_720_url || video.thumbnail_480_url || video.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${video.id}`,
            video_url: videoUrl || `https://www.dailymotion.com/video/${video.id}`,
            video_id: video.id,
            duree: formatDuration(video.duration),
            duree_secondes: video.duration,
            qualite: '360p',
            chaine: video['owner.screenname'] || ''
          });
        } catch (err) {
          console.log('Error processing video:', video.id, err.message);
        }
      }
      
      return {
        videos: results,
        hasNextPage: apiResponse.data.has_more || false,
        totalCount: apiResponse.data.total || results.length
      };
    }
  } catch (apiError) {
    console.log('API error:', apiError.message);
  }
  
  try {
    console.log('Falling back to HTML scraping...');
    const searchUrl = `https://www.dailymotion.com/search/${encodeURIComponent(query)}/videos`;
    const html = await fetchPage(searchUrl);
    const $ = cheerio.load(html);
    
    const videoLinks = [];
    $('a[href*="/video/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const match = href.match(/\/video\/([a-zA-Z0-9]+)/);
        if (match && match[1] && !videoLinks.includes(match[1])) {
          videoLinks.push(match[1]);
        }
      }
    });
    
    console.log('Found video links:', videoLinks.length);
    
    for (const videoId of videoLinks.slice(0, 20)) {
      try {
        const metadata = await getVideoMetadata(videoId);
        if (metadata && metadata.duration >= minDurationSeconds) {
          const videoUrl = await extractVideoUrl(metadata);
          
          results.push({
            titre: metadata.title || 'Sans titre',
            image_url: metadata.poster_url || metadata.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${videoId}`,
            video_url: videoUrl || `https://www.dailymotion.com/video/${videoId}`,
            video_id: videoId,
            duree: formatDuration(metadata.duration),
            duree_secondes: metadata.duration,
            qualite: '360p'
          });
        }
      } catch (e) {
        console.log(`Error fetching video ${videoId}:`, e.message);
      }
    }
  } catch (scrapeError) {
    console.log('Scrape error:', scrapeError.message);
  }
  
  return {
    videos: results,
    hasNextPage: results.length >= 10,
    totalCount: results.length
  };
}

async function getVideoInfo(videoId) {
  try {
    const pageUrl = `https://www.dailymotion.com/video/${videoId}`;
    const html = await fetchPage(pageUrl);
    
    const videoInfo = extractVideoInfoFromHtml(html);
    const metadata = await getVideoMetadata(videoId);
    const videoUrl = await extractVideoUrl(metadata);
    
    if (videoInfo && videoInfo.video) {
      const video = videoInfo.video;
      return {
        titre: video.title || 'Sans titre',
        image_url: video.thumbnail || `https://www.dailymotion.com/thumbnail/video/${videoId}`,
        video_url: videoUrl || `https://www.dailymotion.com/video/${videoId}`,
        video_id: video.xid || videoId,
        duree: formatDuration(video.duration || 0),
        duree_secondes: video.duration || 0,
        qualite: '360p',
        chaine: videoInfo.channel?.displayName || '',
        description: metadata?.description || ''
      };
    }
    
    if (metadata) {
      return {
        titre: metadata.title || 'Sans titre',
        image_url: metadata.poster_url || metadata.thumbnail_url || `https://www.dailymotion.com/thumbnail/video/${videoId}`,
        video_url: videoUrl || `https://www.dailymotion.com/video/${videoId}`,
        video_id: videoId,
        duree: formatDuration(metadata.duration || 0),
        duree_secondes: metadata.duration || 0,
        qualite: '360p',
        description: metadata.description || ''
      };
    }
    
    throw new Error('Impossible de récupérer les informations de la vidéo');
  } catch (error) {
    console.error('Erreur video info:', error.message);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    message: 'Dailymotion Scraper API',
    description: 'API pour rechercher des vidéos Dailymotion de longue durée (1h30+) en qualité 360p',
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
    exemple: '/recherche?video=APOCALYPTO&page=1',
    filtres: {
      duree_minimum: '1h30 (90 minutes)',
      qualite: '360p (basse qualité)'
    }
  });
});

app.get('/recherche', async (req, res) => {
  try {
    const { video, page = 1 } = req.query;
    
    if (!video) {
      return res.status(400).json({
        erreur: 'Le paramètre video est requis',
        exemple: '/recherche?video=APOCALYPTO&page=1'
      });
    }
    
    const pageNum = parseInt(page) || 1;
    const result = await searchVideos(video, pageNum);
    
    res.json({
      recherche: video,
      page: pageNum,
      total_resultats: result.videos.length,
      total_disponible: result.totalCount,
      page_suivante: result.hasNextPage,
      filtre: 'Durée minimum 1h30 (90 minutes)',
      qualite: '360p (basse qualité)',
      resultats: result.videos
    });
    
  } catch (error) {
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
