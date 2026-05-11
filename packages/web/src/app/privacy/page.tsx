import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "개인정보 처리방침 — EVE",
  description: "EVE가 베타 기간에 Gmail, Calendar, 계정 데이터를 처리하는 방식입니다.",
};

const updatedAt = "2026년 5월 4일";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <div className="space-y-3 text-sm leading-6 text-stone-300">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#10100d] text-white">
      <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-300 text-sm font-bold text-stone-950">
            J
          </div>
          <span className="text-lg font-bold tracking-tight">Jigeum</span>
        </Link>
        <div className="flex items-center gap-5 text-sm text-stone-400">
          <Link href="/terms" className="transition hover:text-white">
            약관
          </Link>
          <Link href="/login" className="transition hover:text-white">
            로그인
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-200">
          개인정보 처리방침
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-5xl">
          EVE는 업무 데이터를 이렇게 다룹니다
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-stone-400">
          최종 업데이트: {updatedAt}. EVE는 현재 베타 제품입니다. 이 문서는 EVE가 어떤 데이터에
          접근하는지, 왜 접근하는지, 사용자가 어떻게 삭제를 요청할 수 있는지 설명합니다.
        </p>

        <div className="mt-12 space-y-10">
          <Section title="EVE가 하는 일">
            <p>
              EVE는 Gmail, Calendar, 할 일, 리마인더, 알림, 관련 업무 맥락을 함께 검토해 중요한
              답장, 회의, 후속 조치를 결정하기 쉽게 정리하는 업무용 Decision OS입니다.
            </p>
          </Section>

          <Section title="수집하는 데이터">
            <p>EVE를 사용할 때 다음 데이터를 수집하거나 저장할 수 있습니다.</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>이메일 주소, 이름 같은 계정 정보.</li>
              <li>
                Gmail과 Calendar를 연결하고 백그라운드 동기화를 수행하는 데 필요한 Google OAuth
                토큰.
              </li>
              <li>
                발신자, 수신자, 제목, 스니펫, 본문, 라벨, 읽음 상태, 스레드 ID, AI가 생성한 요약이나
                답장 필요 신호 같은 Gmail 메타데이터와 콘텐츠.
              </li>
              <li>제목, 시간, 참석자, 위치, 설명 같은 Calendar 일정 정보.</li>
              <li>
                할 일, 리마인더, 메모, 약속, 승인 액션, 피드백, 알림, 채팅 메시지 등 EVE에서
                사용자가 만드는 제품 데이터.
              </li>
              <li>베타 운영과 개선에 필요한 사용량, 토큰, 오류, 전달 로그.</li>
            </ul>
          </Section>

          <Section title="데이터 사용 방식">
            <p>EVE는 제품 제공과 개선을 위해서만 데이터를 사용합니다. 예시는 다음과 같습니다.</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>Google 연결 후 Gmail과 Calendar를 동기화합니다.</li>
              <li>아침 브리핑을 만들고 주의가 필요한 메일이나 회의를 찾습니다.</li>
              <li>승인 제안, 리마인더, 할 일, 알림을 만듭니다.</li>
              <li>베타 기간에 EVE의 제안이 유용한지 측정합니다.</li>
              <li>안정성 문제를 디버깅하고, 오남용을 막고, 서비스를 보호합니다.</li>
            </ul>
          </Section>

          <Section title="Google 사용자 데이터">
            <p>
              EVE는 업무 맥락을 읽고, 중요한 메시지를 찾고, 일정 맥락을 관리하고, 사용자가 승인할
              액션을 준비하기 위해 Gmail과 Calendar 권한을 요청합니다.
            </p>
            <p>
              EVE는 Google 사용자 데이터를 판매하지 않습니다. 광고 목적으로 사용하지 않으며, 관련
              없는 제3자에게 이전하지 않습니다. Google 사용자 데이터는 사용자-facing EVE 기능을
              제공하거나 개선하는 데에만 사용합니다.
            </p>
            <p>
              이메일 발송은 민감한 액션으로 취급합니다. 베타 기간에 EVE는 사용자를 대신해 조용히
              답장을 보내지 않습니다. 이메일 액션은 발송 전 사용자 승인이 필요합니다.
            </p>
          </Section>

          <Section title="AI 처리">
            <p>
              EVE는 요약, 분류, 초안 작성, 우선순위 판단을 위해 이메일 스니펫, 본문, 일정 세부 정보,
              할 일, 메모 같은 관련 업무 맥락을 AI 모델 제공자에게 보낼 수 있습니다. 사용 중인
              기능에 필요한 맥락만 보냅니다.
            </p>
          </Section>

          <Section title="보관과 삭제">
            <p>
              계정이 활성 상태인 동안 또는 베타 운영에 필요한 기간 동안 계정 및 워크스페이스
              데이터를 보관합니다. 사용자는 언제든 데이터 내보내기나 삭제를 요청할 수 있습니다.
            </p>
            <p>
              계정 데이터 삭제를 원하면{" "}
              <a className="text-amber-200 hover:text-amber-100" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              로 연락해주세요. 인증된 사용자는 EVE 앱 안의 데이터 삭제 엔드포인트를 사용할 수도
              있습니다. EVE 데이터를 삭제해도, 사용자가 EVE 안에서 명시적으로 승인하지 않는 한
              Google 계정의 메시지나 일정은 삭제되지 않습니다.
            </p>
          </Section>

          <Section title="보안">
            <p>
              EVE는 접근 제어, 인증, 운영상 보호 장치를 사용해 사용자 데이터를 보호합니다. EVE는
              베타 제품이므로 베타 제품에 연결하기 부담스러운 정보가 담긴 계정은 연결하지 않는 것을
              권장합니다.
            </p>
          </Section>

          <Section title="문의">
            <p>
              질문, 삭제 요청, 보안 관련 문의는{" "}
              <a className="text-amber-200 hover:text-amber-100" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              로 보내주세요.
            </p>
          </Section>
        </div>
      </article>
    </main>
  );
}
