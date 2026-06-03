#!/usr/bin/env node
/**
 * 小宇宙播客主页 fetcher（onboarding-chat 的 helper）。
 *
 * 解析小宇宙播客 URL 的 og:title / og:description / __NEXT_DATA__，提取：
 *   - name（播客名）
 *   - description（播客简介）
 *   - hosts（主播列表，从 __NEXT_DATA__）
 *   - past_episode_titles（最近 10 期标题）
 *   - subscriber_count（订阅数，如有）
 *
 * 用法：
 *   node fetch_xiaoyuzhou.js <url>
 *
 * 输出：JSON 到 stdout。fetch / parse 失败时输出 {error: "..."} 并 exit 1。
 *
 * 设计：纯函数 + stdout JSON。skill agent 调它后把结果拼进 onboarding 对话。
 *       独立于旧 parse_podcast_link.js（避免依赖 UserManager / yaml 系统）。
 */

const https = require('https');

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) podcastcut-chat-onboarding' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function parseXiaoyuzhouHtml(html) {
  const result = {
    name: null,
    description: null,
    hosts: [],
    past_episode_titles: [],
    subscriber_count: null
  };

  // og:title 作为播客名 fallback（__NEXT_DATA__ 里有更准的）
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (titleMatch) result.name = titleMatch[1].trim();

  const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
    || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (descMatch) result.description = descMatch[1].trim();

  // __NEXT_DATA__ 是 Next.js server-rendered 数据，结构最稳
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // 不同小宇宙页面 props 路径不同；列几种常见的
      const candidates = [
        nextData?.props?.pageProps?.podcast,
        nextData?.props?.pageProps?.podcastData,
        nextData?.props?.pageProps?.data?.podcast,
        nextData?.props?.initialState?.podcast
      ].filter(Boolean);
      const podcast = candidates[0];
      if (podcast) {
        if (podcast.title) result.name = podcast.title;
        if (podcast.brief) result.description = podcast.brief;
        else if (podcast.description) result.description = podcast.description;
        if (podcast.subscriptionCount) result.subscriber_count = podcast.subscriptionCount;
        if (Array.isArray(podcast.podcasters)) {
          result.hosts = podcast.podcasters.map(p => p.nickname || p.name).filter(Boolean);
        }
      }
      // 最近期数标题：通常在 pageProps.episodes
      const episodes = nextData?.props?.pageProps?.episodes
        || nextData?.props?.pageProps?.data?.episodes
        || podcast?.episodes;
      if (Array.isArray(episodes)) {
        result.past_episode_titles = episodes.slice(0, 10).map(e => e.title).filter(Boolean);
      }
    } catch (e) {
      // __NEXT_DATA__ 解析失败时，meta 也够用
    }
  }

  return result;
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error(JSON.stringify({ error: '需要 URL: node fetch_xiaoyuzhou.js <url>' }));
    process.exit(1);
  }
  if (!/xiaoyuzhoufm\.com\/podcast\//.test(url)) {
    console.error(JSON.stringify({ error: '不是有效的小宇宙播客主页 URL（需要包含 xiaoyuzhoufm.com/podcast/）' }));
    process.exit(1);
  }
  try {
    const html = await fetchUrl(url);
    const result = parseXiaoyuzhouHtml(html);
    result.url = url;
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseXiaoyuzhouHtml, fetchUrl };
