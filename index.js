const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'cache.json');

// ─── CACHE ────────────────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch (e) {}
}
function makeCacheKey(title, artist) {
  return (title + '_' + artist).toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 60);
}

// ─── SIMILARITÉ ───────────────────────────────────────────────────────────────
function editDistance(s1, s2) {
  s1 = s1.toLowerCase(); s2 = s2.toLowerCase();
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) costs[j] = j;
      else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1))
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}
function similarity(s1, s2) {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 100;
  return Math.round(((longer.length - editDistance(longer, shorter)) / longer.length) * 100);
}

// ─── PHASE 0 : YouTube ────────────────────────────────────────────────────────
async function identifyViaYouTube(query, youtubeUrl) {
  const KEY = process.env.YOUTUBE_API_KEY;
  try {
    let videoId;
    if (youtubeUrl) {
      const match = youtubeUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
      videoId = match ? match[1] : null;
    }
    if (!videoId) {
      const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: { part: 'snippet', q: query + ' official', type: 'video', maxResults: 1, key: KEY },
        timeout: 8000
      });
      if (!res.data.items?.length) return { found: false, reason: 'Aucune vidéo YouTube trouvée' };
      videoId = res.data.items[0].id.videoId;
    }
    const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'snippet', id: videoId, key: KEY },
      timeout: 8000
    });
    const video = res.data.items?.[0]?.snippet;
    if (!video) return { found: false, reason: 'Vidéo YouTube introuvable' };
    const title = video.title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
    return { found: true, title, artist: video.channelTitle, youtubeUrl: `https://www.youtube.com/watch?v=${videoId}` };
  } catch (e) {
    return { found: false, reason: 'Erreur YouTube API: ' + e.message };
  }
}

// ─── PHASE 1 : Genius API officielle ─────────────────────────────────────────
async function fetchLyricsFromGenius(title, artist) {
  const KEY = process.env.GENIUS_API_KEY;
  try {
    const searchRes = await axios.get('https://api.genius.com/search', {
      headers: { Authorization: `Bearer ${KEY}` },
      params: { q: `${title} ${artist}` },
      timeout: 8000
    });
    const hits = searchRes.data.response.hits;
    if (!hits?.length) return { found: false, reason: 'Aucun résultat Genius' };

    // Trouver le meilleur match parmi les 5 premiers
    let bestMatch = null, bestScore = 0;
    for (const hit of hits.slice(0, 5)) {
      const song = hit.result;
      const titleSim = similarity(title, song.title);
      const artistSim = similarity(artist, song.primary_artist.name);
      const avg = (titleSim + artistSim) / 2;
      if (avg > bestScore) {
        bestScore = avg;
        bestMatch = { id: song.id, title: song.title, artist: song.primary_artist.name, url: song.url, titleSim, artistSim };
      }
    }

    if (!bestMatch || bestScore < 60) {
      return { found: false, reason: `Similarité trop faible: ${Math.round(bestScore)}%` };
    }

    // Récupérer paroles via API officielle
    const songRes = await axios.get(`https://api.genius.com/songs/${bestMatch.id}?text_format=plain`, {
      headers: { Authorization: `Bearer ${KEY}` },
      timeout: 8000
    });

    const lyrics = songRes.data?.response?.song?.lyrics?.plain;
    if (!lyrics || lyrics.length < 50) {
      return { found: false, reason: 'Paroles absentes ou trop courtes dans Genius API' };
    }

    return {
      found: true,
      lyrics,
      title: bestMatch.title,
      artist: bestMatch.artist,
      geniusUrl: bestMatch.url,
      titleSimilarity: bestMatch.titleSim,
      artistSimilarity: bestMatch.artistSim
    };
  } catch (e) {
    return { found: false, reason: 'Erreur Genius API: ' + e.message };
  }
}

// ─── PHASE 2 : PraiseCharts (scraping léger) ──────────────────────────────────
async function searchPraiseCharts(title, artist) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`);
    const res = await axios.get(`https://www.praisecharts.com/songs/search/?s=${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000
    });
    const $ = cheerio.load(res.data);
    let songUrl = null, songTitle = '';
    $('a[href*="/songs/details/"]').first().each((i, el) => {
      songUrl = 'https://www.praisecharts.com' + $(el).attr('href');
      songTitle = $(el).text().trim();
    });
    if (!songUrl) return { found: false };
    const sim = similarity(title, songTitle);
    if (sim < 55) return { found: false };
    return { found: true, source: 'PraiseCharts', url: songUrl, similarity: sim };
  } catch (e) {
    return { found: false };
  }
}

// ─── PHASE 2B : WorshipTogether ───────────────────────────────────────────────
async function searchWorshipTogether(title, artist) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`);
    const res = await axios.get(`https://www.worshiptogether.com/?s=${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000
    });
    const $ = cheerio.load(res.data);
    let songUrl = null, songTitle = '';
    $('h2.entry-title a, .song-title a, article a').first().each((i, el) => {
      songUrl = $(el).attr('href');
      songTitle = $(el).text().trim();
    });
    if (!songUrl) return { found: false };
    const sim = similarity(title, songTitle);
    if (sim < 55) return { found: false };
    return { found: true, source: 'WorshipTogether', url: songUrl, similarity: sim };
  } catch (e) {
    return { found: false };
  }
}

// ─── ENDPOINT PRINCIPAL ───────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, youtubeUrl } = req.body;
  if (!query && !youtubeUrl) return res.status(400).json({ found: false, reason: 'query ou youtubeUrl requis' });

  const cache = loadCache();

  // Phase 0 — YouTube
  const yt = await identifyViaYouTube(query, youtubeUrl);
  if (!yt.found) return res.json({ found: false, phase: 'youtube', reason: yt.reason,
    message: '🔍 Chant non identifié sur YouTube. Essayez avec une URL YouTube directe.' });

  // Cache check
  const cacheKey = makeCacheKey(yt.title, yt.artist);
  if (cache[cacheKey]) {
    cache[cacheKey].view_count = (cache[cacheKey].view_count || 0) + 1;
    saveCache(cache);
    return res.json({ ...cache[cacheKey], fromCache: true, cacheStatus: '⚡ Grille instantanée depuis le cache' });
  }

  // Phase 1 — Genius
  const genius = await fetchLyricsFromGenius(yt.title, yt.artist);
  if (!genius.found) return res.json({ found: false, phase: 'genius', reason: genius.reason,
    message: '📖 Paroles non trouvées avec certitude.' });

  // Phase 2 — Sources accords en parallèle
  const [praiseCharts, worshipTogether] = await Promise.all([
    searchPraiseCharts(genius.title, genius.artist),
    searchWorshipTogether(genius.title, genius.artist)
  ]);

  const chordSources = [];
  if (praiseCharts.found) chordSources.push(praiseCharts);
  if (worshipTogether.found) chordSources.push(worshipTogether);

  const result = {
    found: true,
    fromCache: false,
    title: genius.title,
    artist: genius.artist,
    lyrics: genius.lyrics,
    youtubeUrl: yt.youtubeUrl,
    chordSources,
    hasYoutubeUrl: !!youtubeUrl,
    metadata: {
      genius_url: genius.geniusUrl,
      title_similarity: genius.titleSimilarity,
      artist_similarity: genius.artistSimilarity,
      chords_sources: chordSources
    },
    cacheStatus: '🆕 Nouvelle grille validée',
    view_count: 1,
    date_creation: new Date().toISOString(),
    verification: {
      youtube: `✅ "${yt.title}" — ${yt.artist}`,
      lyrics: `✅ Paroles Genius API (titre: ${genius.titleSimilarity}%, artiste: ${genius.artistSimilarity}%)`,
      chords: chordSources.length > 0
        ? `✅ ${chordSources.length} source(s) : ${chordSources.map(s => s.source).join(', ')}`
        : '⚠️ Aucune source accords — LLM alignera sur paroles vérifiées'
    }
  };

  cache[cacheKey] = result;
  saveCache(cache);
  return res.json(result);
});

// ─── HEALTH + STATS ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: '🎹 Piano Louange Backend v3.0 ✅', cache: Object.keys(loadCache()).length + ' chants' });
});

app.get('/api/cache/stats', (req, res) => {
  const cache = loadCache();
  const songs = Object.values(cache);
  res.json({
    total: songs.length,
    topSongs: songs.sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
      .slice(0, 10).map(s => ({ title: s.title, artist: s.artist, views: s.view_count }))
  });
});

app.listen(PORT, () => console.log(`🎹 Piano Louange Backend v3.0 démarré sur le port ${PORT}`));
