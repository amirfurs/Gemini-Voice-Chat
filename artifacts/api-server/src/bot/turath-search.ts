import { logger } from "../lib/logger";

const BASE_URL = "https://turath-gpt-proxy.onrender.com";

const DEFAULT_HEADERS = { "Accept": "application/json" };

async function apiFetch(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  logger.info({ url }, "Turath API call");
  const res = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    throw new Error(`Turath API error ${res.status}: ${url}`);
  }
  const json = await res.json();
  logger.info({ url, status: res.status }, "Turath API response received");
  return json;
}

export async function searchBooks(query: string): Promise<unknown> {
  return apiFetch(`/books/search?q=${encodeURIComponent(query)}`);
}

export async function searchTextInBook(
  query: string,
  bookId: number,
  page = 1
): Promise<unknown> {
  return apiFetch(
    `/search/text?q=${encodeURIComponent(query)}&book_id=${bookId}&page=${page}`
  );
}

export async function searchAllTexts(query: string, page = 1): Promise<unknown> {
  return apiFetch(`/search/text?q=${encodeURIComponent(query)}&page=${page}`);
}

export async function getBookIndexTop(bookId: number): Promise<unknown> {
  return apiFetch(`/books/${bookId}/index/top?max_level=1&limit=30`);
}

export async function searchBookIndex(bookId: number, query: string): Promise<unknown> {
  return apiFetch(
    `/books/${bookId}/index/search?q=${encodeURIComponent(query)}&limit=10`
  );
}

export async function checkHealth(): Promise<unknown> {
  return apiFetch("/health");
}

export const TOOL_DECLARATIONS = [
  {
    name: "search_books",
    description:
      "البحث عن كتاب في قاعدة بيانات التراث الإسلامي للحصول على معرّفه (book_id). استخدمه أولاً قبل البحث في نص الكتاب.",
    parameters: {
      type: "OBJECT",
      properties: {
        book_name: {
          type: "STRING",
          description: "اسم الكتاب، مثل: درء تعارض العقل والنقل، أو منهاج السنة النبوية",
        },
      },
      required: ["book_name"],
    },
  },
  {
    name: "search_text_in_book",
    description:
      "البحث في النص الأصلي لكتاب معين عن كلمة أو عبارة لاستخراج اقتباسات حرفية من أقوال العلماء.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "الكلمة أو العبارة المراد البحث عنها داخل الكتاب",
        },
        book_id: {
          type: "NUMBER",
          description: "معرّف الكتاب الذي تم الحصول عليه من search_books",
        },
        page: {
          type: "NUMBER",
          description: "رقم صفحة النتائج (اختياري، الافتراضي 1)",
        },
      },
      required: ["query", "book_id"],
    },
  },
  {
    name: "search_all_texts",
    description:
      "البحث في جميع كتب التراث المتاحة عن موضوع معين. استخدمه عندما لا تعرف الكتاب المحدد.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "الكلمة أو العبارة المراد البحث عنها في جميع الكتب",
        },
        page: {
          type: "NUMBER",
          description: "رقم صفحة النتائج (اختياري، الافتراضي 1)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_book_index",
    description:
      "البحث في فهرس كتاب معين عن موضوع لتحديد الأقسام ذات الصلة قبل البحث في النص.",
    parameters: {
      type: "OBJECT",
      properties: {
        book_id: { type: "NUMBER", description: "معرّف الكتاب" },
        query: {
          type: "STRING",
          description: "موضوع البحث في الفهرس",
        },
      },
      required: ["book_id", "query"],
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  logger.info({ tool: name, args }, "Executing Turath tool");

  try {
    switch (name) {
      case "search_books":
        return await searchBooks(args["book_name"] as string);

      case "search_text_in_book":
        return await searchTextInBook(
          args["query"] as string,
          args["book_id"] as number,
          (args["page"] as number | undefined) ?? 1
        );

      case "search_all_texts":
        return await searchAllTexts(
          args["query"] as string,
          (args["page"] as number | undefined) ?? 1
        );

      case "search_book_index":
        return await searchBookIndex(
          args["book_id"] as number,
          args["query"] as string
        );

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ tool: name, err: message }, "Tool execution failed");
    return { error: message };
  }
}
