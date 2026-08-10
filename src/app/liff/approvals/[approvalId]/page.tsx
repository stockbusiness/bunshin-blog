import { ApprovalDetail } from '../_components/approval-detail';

/**
 * `/liff/approvals/[approvalId]` 承認詳細（TASKS F-5、SPEC 6.1）。
 *
 * **`params` はここで解く。** クライアント側は文字列のIDだけを受け取る。
 */
export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ approvalId: string }>;
}) {
  const { approvalId } = await params;

  return <ApprovalDetail approvalId={approvalId} />;
}
