import React, { useState } from 'react';
import { EditList } from './EditList.tsx';
import { groupMenuRows, groupRows, applyTagKey, GROUP_LABEL, type TagGroup } from '../tagRows.ts';
import { joinTags, splitTags } from '../tagGroups.ts';

export interface TagEditorProps {
  columns: number;
  /** the current tag string (the same text `salu add --tags` takes) */
  tags: string;
  /** called with the new tag string after each change; return an error to reject it */
  onChange: (tags: string) => string | null | undefined | Promise<string | null | undefined>;
  onClose: () => void;
  /** reports the group being edited (null at the top) so the caller can show it in the title */
  onGroup?: (g: TagGroup | null) => void;
}

/** Tags split into groups: pick "Model / effort", "Tools" or "Other", then its settings. */
export function TagEditor(p: TagEditorProps) {
  const [group, setGroupState] = useState<TagGroup | null>(null);
  const [menuAt, setMenuAt] = useState(0);
  const setGroup = (g: TagGroup | null) => {
    setGroupState(g);
    p.onGroup?.(g);
  };
  const parts = splitTags(p.tags);
  if (!group) {
    return (
      <EditList
        key="menu"
        columns={p.columns}
        rows={groupMenuRows(parts)}
        start={menuAt}
        onSet={() => null}
        onMenu={(k) => {
          setMenuAt(['me', 'tools', 'other'].indexOf(k));
          setGroup(k as TagGroup);
        }}
        onBack={p.onClose}
      />
    );
  }
  return (
    <EditList
      key={group}
      columns={p.columns}
      rows={groupRows(group, parts)}
      onSet={(key, raw) => {
        const r = applyTagKey(parts, key, raw);
        if (r.error) return r.error;
        return p.onChange(joinTags(r.parts));
      }}
      onBack={() => setGroup(null)}
    />
  );
}

export { GROUP_LABEL };
