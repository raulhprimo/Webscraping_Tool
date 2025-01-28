import express, { Request, Response } from 'express';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import fs from 'fs';
import { promisify } from 'util';
import puppeteer from 'puppeteer';

const pipeline = promisify(require('stream').pipeline);

// Carrega as variáveis de ambiente do arquivo .env
dotenv.config();

const app = express();
const port = 3001;

// Tokens de API
const GRAPH_TOKEN = process.env.NEXT_PUBLIC_GRAPH_TOKEN;
const FB_APP_ID = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID;
const FB_CLIENT_TOKEN = process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_TOKEN;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Criar diretório para downloads se não existir
const downloadsDir = path.join(__dirname, '../downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

interface ScrapeRequest {
  url: string;
}

interface VideoMetadata {
  title: string;
  description: string;
  thumbnailUrl: string;
  videoUrl?: string;
  platform: 'instagram' | 'tiktok' | 'facebook';
  [key: string]: any;
}

const SOCIAL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.post('/scrape', async (req: Request<{}, {}, ScrapeRequest>, res: Response) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL não fornecida' });
    }

    const platform = detectPlatform(url);
    if (!platform) {
      return res.status(400).json({ error: 'URL não suportada. Use URLs do Instagram, TikTok ou Facebook.' });
    }

    console.log(`Iniciando scraping para plataforma: ${platform}`);
    console.log(`URL: ${url}`);

    try {
      let metadata: VideoMetadata = {
        title: '',
        description: '',
        thumbnailUrl: '',
        platform,
      };

      if (platform === 'facebook') {
        metadata = await scrapeFacebook(url, metadata);
      } else {
        const response = await axios.get(url, { 
          headers: SOCIAL_HEADERS,
          maxRedirects: 5
        });
        
        console.log('Resposta recebida da plataforma');
        const $ = cheerio.load(response.data);

        if (platform === 'tiktok') {
          metadata = await scrapeTikTok($, url, metadata, response.data);
        } else {
          console.log('Iniciando scraping do Instagram');
          metadata = await scrapeInstagram($, metadata, url);
          console.log('Metadados coletados:', {
            title: metadata.title,
            description: metadata.description?.substring(0, 100) + '...',
            thumbnailUrl: metadata.thumbnailUrl?.substring(0, 100) + '...',
            videoUrl: metadata.videoUrl?.substring(0, 100) + '...'
          });
        }
      }

      res.json(metadata);
    } catch (apiError: any) {
      console.error('Erro ao fazer scraping:', apiError.response?.data || apiError.message);
      res.status(500).json({ 
        error: 'Erro ao fazer scraping da página',
        details: apiError.response?.data || apiError.message
      });
    }
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro ao processar a requisição' });
  }
});

async function scrapeFacebook(url: string, metadata: VideoMetadata): Promise<VideoMetadata> {
  try {
    // Primeiro tentar o método tradicional com meta tags
    const response = await axios.get(url, {
      headers: SOCIAL_HEADERS
    });
    
    const $ = cheerio.load(response.data);
    
    // Coletar meta tags
    $('meta').each((_, element) => {
      const property = $(element).attr('property') || $(element).attr('name');
      const content = $(element).attr('content');
      
      if (property && content) {
        if (property === 'og:title') metadata.title = content;
        if (property === 'og:description') metadata.description = content;
        if (property === 'og:image') metadata.thumbnailUrl = content;
        
        // Coletar todas as meta tags relevantes
        if (property.startsWith('og:') || property.startsWith('fb:')) {
          metadata[property] = content;
        }
      }
    });

    // Se não encontrou a URL do vídeo, usar Puppeteer
    console.log('Iniciando Puppeteer para extrair URL do vídeo do Facebook...');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    const page = await browser.newPage();
    
    // Configurar viewport para mobile
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });

    // Interceptar requisições de rede
    let videoUrl = '';
    await page.setRequestInterception(true);

    page.on('request', request => {
      if (request.resourceType() === 'media') {
        console.log('Requisição de mídia interceptada:', request.url());
        const url = request.url();
        if (url.includes('.mp4') || url.includes('/video/')) {
          videoUrl = url;
        }
      }
      request.continue();
    });

    // Configurar headers específicos para Facebook
    await page.setExtraHTTPHeaders({
      ...SOCIAL_HEADERS,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });

    // Navegar para a página
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    // Tentar diferentes seletores para o vídeo
    const videoSelectors = [
      'video[src]',
      'video source[src]',
      '.x1lliihq video', // Classe específica do Facebook
      '[data-video-id] video',
      'video[data-video-id]',
      '.x78zum5 video', // Outra classe do Facebook
      '[role="presentation"] video'
    ];

    for (const selector of videoSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const foundVideoUrl = await page.evaluate((sel) => {
          const videoElement = document.querySelector(sel);
          return videoElement?.getAttribute('src') || 
                 videoElement?.querySelector('source')?.getAttribute('src') ||
                 videoElement?.getAttribute('data-url');
        }, selector);
        
        if (foundVideoUrl) {
          videoUrl = foundVideoUrl;
          console.log('URL do vídeo encontrada via seletor:', selector);
          break;
        }
      } catch (e) {
        console.log(`Seletor ${selector} não encontrado`);
      }
    }

    // Se ainda não encontrou, tentar extrair do HTML
    if (!videoUrl) {
      const pageContent = await page.content();
      const videoMatches = pageContent.match(/["'](?:https?:\/\/[^"']*?\.(?:mp4|m3u8)[^"']*?)["']/i);
      if (videoMatches) {
        videoUrl = videoMatches[1];
        console.log('URL do vídeo encontrada no HTML');
      }
    }

    // Fechar o navegador
    await browser.close();

    if (videoUrl) {
      metadata.videoUrl = videoUrl;
      console.log('URL do vídeo do Facebook encontrada:', videoUrl);
    }

  } catch (error) {
    console.error('Erro ao fazer scraping do Facebook:', error);
  }
  
  return metadata;
}

function extractFacebookVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    
    // Tentar encontrar o ID em diferentes formatos de URL
    if (pathParts.includes('reel')) {
      const reelIndex = pathParts.indexOf('reel');
      if (pathParts[reelIndex + 1]) {
        return pathParts[reelIndex + 1].split('?')[0];
      }
    }
    
    // Outros formatos de URL do Facebook
    for (const part of pathParts) {
      if (part.match(/^\d+$/)) {
        return part;
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

async function scrapeInstagram($: cheerio.CheerioAPI, metadata: VideoMetadata, url: string): Promise<VideoMetadata> {
  // Primeiro tentar o método tradicional
  $('meta').each((_, element) => {
    const property = $(element).attr('property') || $(element).attr('name');
    const content = $(element).attr('content');
    if (property && content) {
      metadata[property] = content;
      if (property === 'og:title') metadata.title = content;
      if (property === 'og:description') metadata.description = content;
      if (property === 'og:image') metadata.thumbnailUrl = content;
    }
  });

  // Se não encontrou a URL do vídeo, usar Puppeteer
  try {
    console.log('Iniciando Puppeteer para extrair URL do vídeo...');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    const page = await browser.newPage();
    
    // Configurar viewport para mobile
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });

    // Interceptar requisições de rede
    let videoUrl = '';
    await page.setRequestInterception(true);

    page.on('request', request => {
      if (request.resourceType() === 'media') {
        console.log('Requisição de mídia interceptada:', request.url());
        const url = request.url();
        if (url.includes('.mp4') || url.includes('/video/')) {
          videoUrl = url;
        }
      }
      request.continue();
    });

    // Configurar headers
    await page.setExtraHTTPHeaders({
      ...SOCIAL_HEADERS,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1'
    });

    // Navegar para a página
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    // Tentar diferentes seletores para o vídeo
    const videoSelectors = [
      'video[src]',
      'video source[src]',
      'video[data-video-id]',
      '.EmbeddedMedia video',
      '[role="presentation"] video'
    ];

    for (const selector of videoSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const foundVideoUrl = await page.evaluate((sel) => {
          const videoElement = document.querySelector(sel);
          return videoElement?.getAttribute('src') || videoElement?.querySelector('source')?.getAttribute('src');
        }, selector);
        
        if (foundVideoUrl) {
          videoUrl = foundVideoUrl;
          break;
        }
      } catch (e) {
        console.log(`Seletor ${selector} não encontrado`);
      }
    }

    // Se ainda não encontrou, tentar extrair do HTML
    if (!videoUrl) {
      const pageContent = await page.content();
      const videoMatches = pageContent.match(/"video_url":"([^"]+)"|"video_secure_url":"([^"]+)"|contentUrl":\s*"([^"]+)"/);
      if (videoMatches) {
        videoUrl = videoMatches[1] || videoMatches[2] || videoMatches[3];
        videoUrl = videoUrl.replace(/\\/g, '');
      }
    }

    console.log('URL do vídeo encontrada:', videoUrl || 'Nenhuma URL encontrada');

    // Fechar o navegador
    await browser.close();

    if (videoUrl) {
      metadata.videoUrl = videoUrl;
    }
  } catch (e) {
    console.error('Erro ao usar Puppeteer:', e);
  }

  return metadata;
}

async function scrapeTikTok($: cheerio.CheerioAPI, url: string, metadata: VideoMetadata, html: string): Promise<VideoMetadata> {
  try {
    // Primeiro tentar o método tradicional com meta tags
    $('meta').each((_, element) => {
      const property = $(element).attr('property') || $(element).attr('name');
      const content = $(element).attr('content');
      
      if (property && content) {
        metadata[property] = content;
        if (property === 'og:title') metadata.title = content;
        if (property === 'og:description') metadata.description = content;
        if (property === 'og:image') metadata.thumbnailUrl = content;
      }
    });

    // Se não encontrou a URL do vídeo, usar Puppeteer
    console.log('Iniciando Puppeteer para extrair URL do vídeo do TikTok...');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    const page = await browser.newPage();
    
    // Configurar viewport para mobile
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    });

    // Interceptar requisições de rede
    let videoUrl = '';
    await page.setRequestInterception(true);

    page.on('request', request => {
      if (request.resourceType() === 'media') {
        console.log('Requisição de mídia interceptada:', request.url());
        const url = request.url();
        if (url.includes('.mp4') || url.includes('/video/')) {
          videoUrl = url;
        }
      }
      request.continue();
    });

    // Configurar headers específicos para TikTok
    await page.setExtraHTTPHeaders({
      ...SOCIAL_HEADERS,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1'
    });

    // Navegar para a página
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    // Tentar diferentes seletores para o vídeo
    const videoSelectors = [
      'video[src]',
      'video source[src]',
      '[data-e2e="browse-video"] video',
      '.video-player video',
      '.tiktok-video video'
    ];

    for (const selector of videoSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const foundVideoUrl = await page.evaluate((sel) => {
          const videoElement = document.querySelector(sel);
          return videoElement?.getAttribute('src') || 
                 videoElement?.querySelector('source')?.getAttribute('src') ||
                 videoElement?.getAttribute('data-src');
        }, selector);
        
        if (foundVideoUrl) {
          videoUrl = foundVideoUrl;
          console.log('URL do vídeo encontrada via seletor:', selector);
          break;
        }
      } catch (e) {
        console.log(`Seletor ${selector} não encontrado`);
      }
    }

    // Se ainda não encontrou, tentar extrair do HTML
    if (!videoUrl) {
      const pageContent = await page.content();
      const videoMatches = pageContent.match(/"playAddr":"([^"]+)"|"downloadAddr":"([^"]+)"|"videoUrl":"([^"]+)"/);
      if (videoMatches) {
        videoUrl = videoMatches[1] || videoMatches[2] || videoMatches[3];
        videoUrl = videoUrl.replace(/\\/g, '');
        console.log('URL do vídeo encontrada no HTML');
      }
    }

    // Fechar o navegador
    await browser.close();

    if (videoUrl) {
      metadata.videoUrl = videoUrl;
      console.log('URL do vídeo do TikTok encontrada:', videoUrl);
    }

  } catch (error) {
    console.error('Erro ao fazer scraping do TikTok:', error);
  }
  
  return metadata;
}

function detectPlatform(url: string): 'instagram' | 'tiktok' | 'facebook' | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    if (hostname.includes('instagram.com')) return 'instagram';
    if (hostname.includes('tiktok.com')) return 'tiktok';
    if (hostname.includes('facebook.com')) return 'facebook';

    return null;
  } catch {
    return null;
  }
}

function extractReelsId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const reelsIndex = pathParts.indexOf('reel');
    
    if (reelsIndex !== -1 && pathParts[reelsIndex + 1]) {
      return pathParts[reelsIndex + 1];
    }
    return null;
  } catch {
    return null;
  }
}

// Novo endpoint para download de vídeos
app.get('/download', async (req: Request, res: Response) => {
  try {
    const { url, videoUrl } = req.query;
    
    if (!url || !videoUrl) {
      return res.status(400).json({ error: 'URL do vídeo não fornecida' });
    }

    const platform = detectPlatform(url as string);
    if (!platform) {
      return res.status(400).json({ error: 'Plataforma não suportada' });
    }

    // Configurar headers para download
    const headers = {
      ...SOCIAL_HEADERS,
      'Referer': platform === 'instagram' ? 'https://www.instagram.com/' : '',
    };

    // Fazer o download do vídeo
    const response = await axios({
      method: 'GET',
      url: videoUrl as string,
      responseType: 'stream',
      headers
    });

    // Gerar nome do arquivo baseado na URL ou timestamp
    const timestamp = new Date().getTime();
    const fileName = `video_${timestamp}.mp4`;
    const filePath = path.join(downloadsDir, fileName);

    // Configurar headers da resposta
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // Fazer o streaming do vídeo para o cliente
    await pipeline(response.data, res);
  } catch (error) {
    console.error('Erro ao fazer download:', error);
    res.status(500).json({ error: 'Erro ao fazer download do vídeo' });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  if (!GRAPH_TOKEN) {
    console.warn('\x1b[33m%s\x1b[0m', 'AVISO: Token do Graph API não encontrado no arquivo .env!');
  }
}); 