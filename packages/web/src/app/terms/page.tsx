import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "서비스 이용약관 — EVE",
  description: "EVE 베타 이용약관입니다.",
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

export default function TermsPage() {
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
          <Link href="/privacy" className="transition hover:text-white">
            개인정보
          </Link>
          <Link href="/login" className="transition hover:text-white">
            로그인
          </Link>
        </div>
      </nav>

      <article className="mx-auto max-w-4xl px-6 py-14">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-200">
          서비스 이용약관
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white md:text-5xl">
          EVE 베타 이용약관
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-stone-400">
          최종 업데이트: {updatedAt}. 이 약관은 EVE 베타에 적용됩니다. EVE를 사용하면 본 약관과
          개인정보 처리방침에 동의한 것으로 간주됩니다.
        </p>

        <div className="mt-12 space-y-10">
          <Section title="베타 제품">
            <p>
              EVE는 현재 베타 제품입니다. 기능은 변경되거나, 일시적으로 동작하지 않거나, 사용량이
              제한되거나, 제거될 수 있습니다. EVE는 요약, 분류, 리마인더, 회의 준비, 제안 액션에서
              오류를 만들 수 있습니다.
            </p>
          </Section>

          <Section title="사용자의 책임">
            <ul className="list-disc space-y-2 pl-5">
              <li>EVE에 연결하는 계정과 데이터에 대한 책임은 사용자에게 있습니다.</li>
              <li>본인이 소유하거나 연결 권한이 있는 계정에 대해서만 EVE를 사용해야 합니다.</li>
              <li>중요한 출력은 사용하거나 의존하기 전에 반드시 검토해야 합니다.</li>
              <li>
                법률, 계약, 개인정보 권리, 플랫폼 규칙을 위반하는 방식으로 EVE를 사용할 수 없습니다.
              </li>
            </ul>
          </Section>

          <Section title="승인과 자동화">
            <p>
              EVE는 리마인더, 브리핑, 분류, 알림, 승인 제안을 만들 수 있습니다. 이메일 발송을 포함한
              민감한 액션은 실행 전에 사용자가 검토하고 승인해야 합니다. 사용자가 승인한 액션에 대한
              책임은 사용자에게 있습니다.
            </p>
          </Section>

          <Section title="Google 서비스">
            <p>
              Gmail 또는 Google Calendar를 연결하면, EVE 기능 제공에 필요한 Google 데이터 접근을
              허용하는 것입니다. Google 계정 설정에서 언제든 EVE의 Google 접근 권한을 철회할 수
              있습니다.
            </p>
          </Section>

          <Section title="전문 조언 아님">
            <p>
              EVE는 업무 정리, 문안 초안, 우선순위 판단을 도울 수 있습니다. EVE는 법률, 금융, 의료,
              고용 또는 기타 전문 조언을 제공하지 않습니다. 중요한 정보는 행동하기 전에 확인해야
              합니다.
            </p>
          </Section>

          <Section title="가용성과 데이터 손실">
            <p>
              EVE는 안정적으로 운영되도록 노력하지만, 베타는 가동 시간 보장 없이 제공됩니다. 베타
              한계, 제3자 장애, 사용자 설정으로 인한 알림 누락, 동기화 지연, 부정확한 출력, 데이터
              손실에 대해 책임지지 않습니다.
            </p>
          </Section>

          <Section title="계정 삭제">
            <p>
              EVE 계정 데이터 삭제는{" "}
              <a className="text-amber-200 hover:text-amber-100" href="mailto:k0820086@gmail.com">
                k0820086@gmail.com
              </a>
              로 요청할 수 있습니다. EVE 계정 데이터를 삭제해도 Google 또는 기타 제3자 서비스의
              데이터가 자동으로 삭제되지는 않습니다.
            </p>
          </Section>

          <Section title="변경">
            <p>
              EVE가 변경됨에 따라 본 약관도 업데이트될 수 있습니다. 업데이트 후에도 EVE를 계속
              사용하면 변경된 약관에 동의한 것으로 간주됩니다.
            </p>
          </Section>

          <Section title="문의">
            <p>
              약관 관련 질문은{" "}
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
