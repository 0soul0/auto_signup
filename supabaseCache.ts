import { createClient } from '@supabase/supabase-js';

// 初始化 Supabase 客戶端
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

// 🧠 建立記憶體快取結構 (記憶體快取層)
interface CacheItem {
  buffer: Buffer;
  timestamp: number;
}
const memoryCache = new Map<string, CacheItem>();

/**
 * 📁 儲存檔案（同時寫入 Supabase 與記憶體快取）
 * @returns {Promise<boolean>} 成功回傳 true，失敗回傳 false
 */
export async function saveToSupabase(key: string, buffer: Buffer): Promise<boolean> {
  const base64Data = buffer.toString('base64');
  
  // 1. 寫入 Supabase
    const { error } = await supabase
    .from('03_auto_signup_file_cache')
    .insert({ 
      key: key, 
      data: base64Data, 
      created_at: new Date().toISOString() 
    });

  if (error) {
    console.error(`儲存檔案到 Supabase 失敗 (${key}):`, error);
    return false; // ❌ 失敗回傳 false
  }

  // 2. 同步更新記憶體快取
  memoryCache.set(key, {
    buffer: buffer,
    timestamp: Date.now()
  });

  return true; // ✅ 成功回傳 true
}

/**
 * 📂 取得檔案：先檢查記憶體快取，沒有/過期才去 Supabase 查詢
 */
export async function getFromSupabase(key: string): Promise<Buffer | null> {
  // 1. 檢查記憶體快取 (Memory Cache)
  const cached = memoryCache.get(key);

    if (cached && cached.buffer && cached.buffer.length > 0) {
        return cached.buffer;
    }else{
        if (memoryCache.has(key)) {
            memoryCache.delete(key);
        } 
    }

  // 2. 記憶體沒有或過期，向 Supabase 查詢
  const { data, error } = await supabase
    .from('03_auto_signup_file_cache')
    .select('data, created_at')
    .eq('key', key)
    .single();

  if (error || !data) {
    return null;
  }

  // 4.還原成 Buffer
  const buffer = Buffer.from(data.data, 'base64');

  // 5. 將結果寫回記憶體快取，下次就不用再跑 Supabase
  memoryCache.set(key, {
    buffer: buffer,
    timestamp: data.created_at // 以資料庫建立時間為基準
  });

  return buffer;
}

/**
 * 🗑️ 手動刪除檔案（同時清除 Supabase 與記憶體快取）
 */
export async function deleteFromSupabase(key: string): Promise<boolean> {
    
    // 判斷記憶體快取中是否存在該 key，存在才刪除
    if (memoryCache.has(key)) {
        memoryCache.delete(key);
    }

  try {
    const { error } = await supabase
      .from('03_auto_signup_file_cache')
      .delete()
      .eq('key', key);

    if (error) {
      console.error(`刪除 Supabase 檔案失敗 (${key}):`, error);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`刪除 Supabase 檔案發生錯誤 (${key}):`, error);
    return false;
  }
}

/**
 * 🧹 批次清除過期檔案（同步清理 Supabase 與記憶體）
 */
export async function cleanExpiredFromSupabase(): Promise<number> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 同步清理記憶體快取中過期的項目
  const now = Date.now();
  for (const [key, item] of memoryCache.entries()) {
    if (now - item.timestamp > 24 * 60 * 60 * 1000) {
      memoryCache.delete(key);
    }
  }

  // 清理 Supabase 資料庫
  const { data, error } = await supabase
    .from('03_auto_signup_file_cache')
    .delete()
    .lt('created_at', twentyFourHoursAgo)
    .select('key');

  if (error) {
    console.error('清除過期 Supabase 快取失敗:', error);
    return 0;
  }

  return data ? data.length : 0;
}