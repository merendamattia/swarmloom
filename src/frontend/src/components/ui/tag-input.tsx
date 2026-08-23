import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/field";

export function TagInput({ id, tags, value, onValueChange, onAdd, onRemove, minimum = 0, placeholder }: {
  id: string;
  tags: string[];
  value: string;
  onValueChange: (value: string) => void;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  minimum?: number;
  placeholder?: string;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onAdd(value);
  };

  return (
    <div className="tag-input">
      <div className="tag-list" aria-live="polite">
        {tags.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
            <button className="tag-remove" type="button" aria-label={`Remove ${tag}`} disabled={tags.length <= minimum} onClick={() => onRemove(tag)}>
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <Input id={id} value={value} placeholder={placeholder} onChange={(event) => onValueChange(event.target.value)} onKeyDown={handleKeyDown} />
    </div>
  );
}
