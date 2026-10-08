import type { PublishIssue } from '../publish-issues';

interface IssuesListProps {
  issues: PublishIssue[];
  onSelectField: (fieldId?: string) => void;
}

/** What blocks publishing. Each item jumps to the field (or form settings) it's about. */
export function IssuesList({ issues, onSelectField }: IssuesListProps) {
  if (!issues.length) return null;
  return (
    <div className="fb-issues" role="status">
      <div className="fb-issues__title">
        {issues.length === 1 ? '1 thing to fix before publishing' : `${issues.length} things to fix before publishing`}
      </div>
      {issues.map((issue, i) => (
        <button key={`${i}:${issue.message}`} type="button" className="fb-issues__item" onClick={() => onSelectField(issue.fieldId)}>
          {issue.fieldLabel ? <strong>{issue.fieldLabel}: </strong> : null}
          {issue.message}
        </button>
      ))}
    </div>
  );
}
