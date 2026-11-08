"use client";

import { useState } from "react";
import type {
  HotelContent,
  HotelReview,
  HotelRoomContent,
} from "../../lib/api-liteapi";

function scoreTone(score: number): string {
  if (score >= 9) return "great";
  if (score >= 8) return "good";
  if (score >= 7) return "ok";
  return "meh";
}

function reviewDate(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function humanType(value: string | null): string | null {
  if (!value) return null;
  return value.split("_").join(" ");
}

/**
 * Everything the provider holds about the hotel beyond the rate: photos, the
 * description, facilities, house rules, what is nearby, what guests praise or
 * complain about, and the reviews themselves.
 */
export function HotelFacts({
  content,
  reviews,
  openGallery,
}: {
  content: HotelContent | null;
  reviews: HotelReview[];
  openGallery: () => void;
}) {
  if (!content) return null;
  const gallery = content.images.slice(1, 7);
  return (
    <div className="hotel-facts">
      {gallery.length > 0 ? (
        <div className="gallery-strip">
          {gallery.map((image) => (
            <button
              className="gallery-thumb"
              key={image.url}
              onClick={openGallery}
              title={image.caption ?? "Hotel photo"}
              type="button"
            >
              <img alt={image.caption ?? content.name} loading="lazy" src={image.url} />
            </button>
          ))}
          <button className="gallery-more" onClick={openGallery} type="button">
            All photos
          </button>
        </div>
      ) : null}

      {content.description ? (
        <section className="fact-block">
          <h3>About this hotel</h3>
          <p className="fact-text">{content.description}</p>
          {content.important_information ? (
            <p className="fact-text muted">{content.important_information}</p>
          ) : null}
        </section>
      ) : null}

      <section className="fact-block">
        <h3>The essentials</h3>
        <dl className="fact-grid">
          {content.checkin_from ? (
            <>
              <dt>Check-in</dt>
              <dd>
                from {content.checkin_from}
                {content.checkin_until ? ` · until ${content.checkin_until}` : ""}
              </dd>
            </>
          ) : null}
          {content.checkout_until ? (
            <>
              <dt>Check-out</dt>
              <dd>until {content.checkout_until}</dd>
            </>
          ) : null}
          {content.chain ? (
            <>
              <dt>Chain</dt>
              <dd>{content.chain}</dd>
            </>
          ) : null}
          {content.hotel_type ? (
            <>
              <dt>Type</dt>
              <dd>{content.hotel_type}</dd>
            </>
          ) : null}
          {content.airport_code ? (
            <>
              <dt>Nearest airport</dt>
              <dd>{content.airport_code}</dd>
            </>
          ) : null}
          {content.phone ? (
            <>
              <dt>Phone</dt>
              <dd>{content.phone}</dd>
            </>
          ) : null}
          {content.policies.length > 0 ? (
            <>
              <dt>House rules</dt>
              <dd>{content.policies.join(" · ")}</dd>
            </>
          ) : null}
          {content.facilities.length > 0 ? (
            <>
              <dt>Facilities</dt>
              <dd>
                <span className="chip-row">
                  {content.facilities.slice(0, 14).map((facility) => (
                    <span className="chip" key={facility}>
                      {facility}
                    </span>
                  ))}
                  {content.facilities.length > 14 ? (
                    <span className="chip muted">
                      +{content.facilities.length - 14} more
                    </span>
                  ) : null}
                </span>
              </dd>
            </>
          ) : null}
          {content.nearby.length > 0 ? (
            <>
              <dt>What is nearby</dt>
              <dd>
                <span className="chip-row">
                  {content.nearby.map((place) => (
                    <span className="chip" key={place.name}>
                      {place.name}
                      {place.distance_km !== null
                        ? ` · ${place.distance_km} km`
                        : ""}
                    </span>
                  ))}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {content.sentiment.pros.length > 0 || content.sentiment.cons.length > 0 ? (
        <section className="fact-block">
          <h3>What guests say</h3>
          <div className="sentiment-grid">
            {content.sentiment.pros.length > 0 ? (
              <div className="sentiment-col">
                <p className="sentiment-label">Guests liked</p>
                <ul className="sentiment-list pros">
                  {content.sentiment.pros.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {content.sentiment.cons.length > 0 ? (
              <div className="sentiment-col">
                <p className="sentiment-label">Could be better</p>
                <ul className="sentiment-list cons">
                  {content.sentiment.cons.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {reviews.length > 0 ? (
        <section className="fact-block">
          <h3>
            Guest reviews
            {content.review_count
              ? ` · ${content.review_count.toLocaleString("en-US")} in total`
              : ""}
          </h3>
          <div className="review-list">
            {reviews.map((review) => (
              <article className="review" key={review.review_id}>
                <div className="review-head">
                  <span className={`review-score ${scoreTone(review.score)}`}>
                    {review.score}
                  </span>
                  <div>
                    <strong>{review.name ?? "Guest"}</strong>
                    <p className="event-meta">
                      {[
                        reviewDate(review.date),
                        humanType(review.traveller_type),
                        review.country ? review.country.toUpperCase() : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </div>
                {review.headline ? (
                  <p className="review-headline">{review.headline}</p>
                ) : null}
                {review.pros ? (
                  <p className="fact-text">
                    <strong>Liked:</strong> {review.pros}
                  </p>
                ) : null}
                {review.cons ? (
                  <p className="fact-text muted">
                    <strong>Disliked:</strong> {review.cons}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** The provider's own description of a room, folded under its rate. */
export function RoomFacts({ room }: { room: HotelRoomContent | null }) {
  if (!room) return null;
  const facts = [
    room.size_square !== null
      ? `${room.size_square} ${room.size_unit ?? "sqm"}`
      : null,
    room.max_occupancy !== null ? `sleeps ${room.max_occupancy}` : null,
    ...room.bed_types.map(
      (bed) => `${bed.quantity} × ${bed.bed_type.toLowerCase()}`,
    ),
  ].filter((value): value is string => value !== null);
  if (facts.length === 0 && !room.description) return null;
  return (
    <details className="room-facts">
      <summary>Room details</summary>
      {facts.length > 0 ? <p className="event-meta">{facts.join(" · ")}</p> : null}
      {room.description ? (
        <p className="fact-text">{room.description}</p>
      ) : null}
      {room.amenities.length > 0 ? (
        <span className="chip-row">
          {room.amenities.slice(0, 10).map((amenity) => (
            <span className="chip" key={amenity}>
              {amenity}
            </span>
          ))}
        </span>
      ) : null}
    </details>
  );
}

/** Full-screen photo viewer for the provider's gallery. */
export function PhotoSheet({
  content,
  onClose,
}: {
  content: HotelContent;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const image = content.images[index];
  return (
    <div className="photo-sheet" role="dialog" aria-label="Hotel photos">
      <button className="photo-sheet-close" onClick={onClose} type="button">
        Close
      </button>
      {image ? (
        <img alt={image.caption ?? content.name} className="photo-sheet-main" src={image.url} />
      ) : null}
      <div className="photo-sheet-strip">
        {content.images.map((item, position) => (
          <button
            className={`photo-sheet-thumb ${position === index ? "active" : ""}`}
            key={item.url}
            onClick={() => setIndex(position)}
            type="button"
          >
            <img alt={item.caption ?? ""} loading="lazy" src={item.url} />
          </button>
        ))}
      </div>
    </div>
  );
}
