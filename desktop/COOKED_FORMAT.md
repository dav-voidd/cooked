# Cooked question bank format (.cooked.json)
Upload a module to Claude chat and say: "Make a Cooked question bank for this module."
Then Import it in Cooked (subject page → "Import from Claude", or drop the .json in the upload box).

```json
{
  "title": "Module 1: ...",
  "summary": "Short overview",
  "concepts": [
    {"id": "c1", "title": "...", "explanation": "...", "importance": "critical|high|medium",
     "must_memorize": ["..."], "visual_ref": "page:3", "visual_description": "..."}
  ],
  "questions": [
    {"type": "mcq", "concept_id": "c1", "prompt": "...", "choices": ["A","B","C","D"], "correct_index": 0, "explanation": "...", "difficulty": 2},
    {"type": "true_false", "concept_id": "c1", "prompt": "...", "correct_index": 1, "explanation": "..."},
    {"type": "identification", "concept_id": "c1", "prompt": "...", "answer": "Term", "accepted": ["Term", "Variant"], "explanation": "..."},
    {"type": "fill_blank", "concept_id": "c1", "prompt": "The ____ is ...", "answer": "Term", "accepted": ["Term"], "explanation": "..."},
    {"type": "enumeration", "concept_id": "c1", "prompt": "Enumerate the 3 ...", "items": [{"text": "A", "accepted": ["a variant"]}], "ordered": false, "explanation": "..."},
    {"type": "essay", "concept_id": "c1", "prompt": "Explain ...", "rubric": ["key point 1", "key point 2"], "explanation": "..."}
  ]
}
```
- true_false: correct_index 0 = True, 1 = False.
- visual_ref "page:N" works when you also attach the original PDF during import.
