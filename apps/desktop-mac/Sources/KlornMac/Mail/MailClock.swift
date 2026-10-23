import Foundation

/// The clock the mail list and reader tell time by. A shipping build reads
/// the wall clock and prints the shipping labels; an offscreen preview render
/// (landing captures) reads the fixture clock instead, so the fixture mail —
/// all written on one fixed day — reads as today's mail ("15:20"), never as a
/// stale absolute date ("Jul 29", "7월 29일") on the landings.
enum MailClock {
    /// 2026-07-29 08:30 UTC (17:30 in Seoul): just after the newest fixture
    /// mail (08:12 UTC), and the same calendar day in both the CI zone (UTC)
    /// and the capture zone (Asia/Seoul).
    static let fixtureNow = Date(timeIntervalSince1970: 1_785_313_800)

    static func now(renderingOffscreen: Bool) -> Date {
        renderingOffscreen ? fixtureNow : Date()
    }
}

/// Days between two instants by calendar day (not by 24h spans).
private func calendarDaysBetween(_ date: Date, _ now: Date, calendar: Calendar) -> Int? {
    calendar.dateComponents(
        [.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
    ).day
}

/// The preview-only day grain: "Yesterday"/"어제" for the day before, the
/// weekday within the past week, nil past that (the caller falls back to its
/// shipping grain). Both words come from Foundation, so every app language
/// gets its own without new strings — and neither depends on the wall clock,
/// so a fixture clock in the past still says "Yesterday".
func relativeDayLabel(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String? {
    guard let days = calendarDaysBetween(date, now, calendar: calendar), (1...6).contains(days) else {
        return nil
    }
    if days == 1 {
        let relative = RelativeDateTimeFormatter()
        relative.locale = locale
        relative.calendar = calendar
        relative.dateTimeStyle = .named
        relative.formattingContext = .beginningOfSentence
        return relative.localizedString(from: DateComponents(day: -1))
    }
    let weekday = DateFormatter()
    weekday.calendar = calendar
    weekday.timeZone = calendar.timeZone
    weekday.locale = locale
    weekday.setLocalizedDateFormatFromTemplate("EEEE")
    return weekday.string(from: date)
}

/// The reader header's date. Shipping: "Jul 29 · 3:20 PM" in the app's
/// language. With `relativeTo` (preview renders only): today's mail shows
/// the time alone, the past week shows "Yesterday · 3:20 PM" or the weekday,
/// older mail keeps the shipping form. Malformed ISO degrades to "".
func readerDateLabel(
    iso: String?, locale: Locale, calendar: Calendar = DisplayTimeZone.calendar, relativeTo now: Date? = nil
) -> String {
    guard let iso else { return "" }
    let iso1 = ISO8601DateFormatter(); iso1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let iso2 = ISO8601DateFormatter(); iso2.formatOptions = [.withInternetDateTime]
    guard let date = iso1.date(from: iso) ?? iso2.date(from: iso) else { return "" }
    let out = DateFormatter()
    out.calendar = calendar
    out.timeZone = calendar.timeZone
    out.locale = locale
    guard let now else {
        out.dateFormat = "MMM d · h:mm a"
        return out.string(from: date)
    }
    // The locale's own clock ("3:20 PM", "오후 3:20"), not the shipping
    // pattern's fixed "h:mm a" order, now that the time stands alone.
    out.setLocalizedDateFormatFromTemplate("jmm")
    let time = out.string(from: date)
    if calendar.isDate(date, inSameDayAs: now) { return time }
    if let day = relativeDayLabel(date, now: now, calendar: calendar, locale: locale) {
        return "\(day) · \(time)"
    }
    out.dateFormat = "MMM d · h:mm a"
    return out.string(from: date)
}
