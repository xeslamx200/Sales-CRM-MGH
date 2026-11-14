
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "activities": {
                  Row: {
                    "actor_id": string,"body": string | null,"company_id": string,"contact_id": string | null,"created_at": string,"deal_id": string | null,"duration_seconds": number | null,"id": string,"lead_id": string | null,"occurred_at": string,"outcome": string | null,"type": Database["public"]['Enums']["activity_type"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"body"?: string | null,"company_id": string,"contact_id"?: string | null,"created_at"?: string,"deal_id"?: string | null,"duration_seconds"?: number | null,"id"?: string,"lead_id"?: string | null,"occurred_at"?: string,"outcome"?: string | null,"type": Database["public"]['Enums']["activity_type"],"updated_at"?: string
                  }
                  Update: {
                    "actor_id"?: string,"body"?: string | null,"company_id"?: string,"contact_id"?: string | null,"created_at"?: string,"deal_id"?: string | null,"duration_seconds"?: number | null,"id"?: string,"lead_id"?: string | null,"occurred_at"?: string,"outcome"?: string | null,"type"?: Database["public"]['Enums']["activity_type"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "activities_actor_id_fkey"
      columns: ["actor_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "activities_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "activities_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "activities_deal_id_company_id_fkey"
      columns: ["deal_id","company_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "activities_lead_id_company_id_fkey"
      columns: ["lead_id","company_id"]
isOneToOne: false
      referencedRelation: "leads"
      referencedColumns: ["id","company_id"]
    }
                  ]
                },"attachments": {
                  Row: {
                    "company_id": string,"created_at": string,"entity_id": string,"entity_type": string,"file_name": string,"id": string,"mime_type": string,"size_bytes": number,"storage_path": string,"uploaded_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"entity_id": string,"entity_type": string,"file_name": string,"id"?: string,"mime_type": string,"size_bytes": number,"storage_path": string,"uploaded_by"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"entity_id"?: string,"entity_type"?: string,"file_name"?: string,"id"?: string,"mime_type"?: string,"size_bytes"?: number,"storage_path"?: string,"uploaded_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "attachments_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attachments_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_logs": {
                  Row: {
                    "action": string,"actor_id": string | null,"company_id": string | null,"created_at": string,"entity_id": string | null,"entity_type": string,"id": number,"metadata": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"company_id"?: string | null,"created_at"?: string,"entity_id"?: string | null,"entity_type": string,"id"?: never,"metadata"?: NonNullable<Json>
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"company_id"?: string | null,"created_at"?: string,"entity_id"?: string | null,"entity_type"?: string,"id"?: never,"metadata"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_logs_actor_id_fkey"
      columns: ["actor_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "audit_logs_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"auth_events": {
                  Row: {
                    "created_at": string,"event": string,"id": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"event": string,"id"?: never,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"event"?: string,"id"?: never,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "auth_events_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"companies": {
                  Row: {
                    "created_at": string,"created_by": string | null,"currency": string,"id": string,"is_active": boolean,"is_sandbox": boolean,"name": string,"slug": string,"timezone": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"is_active"?: boolean,"is_sandbox"?: boolean,"name": string,"slug": string,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"is_active"?: boolean,"is_sandbox"?: boolean,"name"?: string,"slug"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "companies_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"company_business_hours": {
                  Row: {
                    "closes": string,"company_id": string,"created_at": string,"id": string,"opens": string,"weekday": number
                  }
                  ComputedFields: never
                  Insert: {
                    "closes": string,"company_id": string,"created_at"?: string,"id"?: string,"opens": string,"weekday": number
                  }
                  Update: {
                    "closes"?: string,"company_id"?: string,"created_at"?: string,"id"?: string,"opens"?: string,"weekday"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_business_hours_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"company_holidays": {
                  Row: {
                    "company_id": string,"created_at": string,"day": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"day": string,"name": string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"day"?: string,"name"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_holidays_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"company_roles": {
                  Row: {
                    "base_role": Database["public"]['Enums']["app_role"],"company_id": string,"created_at": string,"created_by": string | null,"hidden_nav": (string)[],"id": string,"name": string,"permissions": Json,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "base_role": Database["public"]['Enums']["app_role"],"company_id": string,"created_at"?: string,"created_by"?: string | null,"hidden_nav"?: (string)[],"id"?: string,"name": string,"permissions"?: Json,"updated_at"?: string
                  }
                  Update: {
                    "base_role"?: Database["public"]['Enums']["app_role"],"company_id"?: string,"created_at"?: string,"created_by"?: string | null,"hidden_nav"?: (string)[],"id"?: string,"name"?: string,"permissions"?: Json,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_roles_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"company_memberships": {
                  Row: {
                    "company_id": string,"created_at": string,"created_by": string | null,"custom_role_id": string | null,"id": string,"is_active": boolean,"role": Database["public"]['Enums']["app_role"],"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"created_by"?: string | null,"custom_role_id"?: string | null,"id"?: string,"is_active"?: boolean,"role": Database["public"]['Enums']["app_role"],"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"created_by"?: string | null,"custom_role_id"?: string | null,"id"?: string,"is_active"?: boolean,"role"?: Database["public"]['Enums']["app_role"],"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_memberships_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "company_memberships_custom_role_id_fkey"
      columns: ["custom_role_id"]
isOneToOne: false
      referencedRelation: "company_roles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "company_memberships_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "company_memberships_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"fx_rates": {
                  Row: {
                    "currency": string,"fetched_at": string,"rate_to_egp": number,"source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "currency": string,"fetched_at": string,"rate_to_egp": number,"source": string
                  }
                  Update: {
                    "currency"?: string,"fetched_at"?: string,"rate_to_egp"?: number,"source"?: string
                  }
                  Relationships: []
                },"payments": {
                  Row: {
                    "amount": number,"amount_egp": number,"company_id": string,"contact_id": string,"created_at": string,"created_by": string,"currency": string,"fx_fetched_at": string | null,"fx_rate_to_egp": number,"fx_source": string,"id": string,"kind": string,"note": string | null,"offering_id": string,"paid_on": string,"review_note": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"company_id": string,"contact_id": string,"created_at"?: string,"created_by": string,"currency": string,"fx_fetched_at"?: string | null,"fx_rate_to_egp": number,"fx_source": string,"id"?: string,"kind": string,"note"?: string | null,"offering_id": string,"paid_on"?: string,"review_note"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"status"?: string
                  }
                  Update: {
                    "amount"?: number,"company_id"?: string,"contact_id"?: string,"created_at"?: string,"created_by"?: string,"currency"?: string,"fx_fetched_at"?: string | null,"fx_rate_to_egp"?: number,"fx_source"?: string,"id"?: string,"kind"?: string,"note"?: string | null,"offering_id"?: string,"paid_on"?: string,"review_note"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },
                    {
      foreignKeyName: "payments_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },
                    {
      foreignKeyName: "payments_reviewed_by_fkey"
      columns: ["reviewed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },
                    {
      foreignKeyName: "payments_offering_id_company_id_fkey"
      columns: ["offering_id", "company_id"]
isOneToOne: false
      referencedRelation: "company_offerings"
      referencedColumns: ["id", "company_id"]
    }
                  ]
                },"performance_exclusions": {
                  Row: {
                    "company_id": string,"excluded_at": string,"excluded_by": string | null,"reason": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"excluded_at"?: string,"excluded_by"?: string | null,"reason"?: string | null,"user_id": string
                  }
                  Update: {
                    "company_id"?: string,"excluded_at"?: string,"excluded_by"?: string | null,"reason"?: string | null,"user_id"?: string
                  }
                  Relationships: []
                },"payment_approval_policy": {
                  Row: {
                    "company_id": string,"enabled_at": string,"enabled_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"enabled_at"?: string,"enabled_by"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"enabled_at"?: string,"enabled_by"?: string | null
                  }
                  Relationships: []
                },"payment_approvers": {
                  Row: {
                    "added_at": string,"added_by": string | null,"company_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "added_at"?: string,"added_by"?: string | null,"company_id": string,"user_id": string
                  }
                  Update: {
                    "added_at"?: string,"added_by"?: string | null,"company_id"?: string,"user_id"?: string
                  }
                  Relationships: []
                },"monthly_target_defaults": {
                  Row: {
                    "amount_egp": number,"company_id": string,"id": string,"updated_at": string,"updated_by": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_egp": number,"company_id": string,"id"?: string,"updated_at"?: string,"updated_by"?: string | null,"user_id"?: string | null
                  }
                  Update: {
                    "amount_egp"?: number,"company_id"?: string,"id"?: string,"updated_at"?: string,"updated_by"?: string | null,"user_id"?: string | null
                  }
                  Relationships: []
                },"workshop_prices": {
                  Row: {
                    "attendance": string,"company_id": string,"country": string,"created_at": string,"created_by": string | null,"currency": string,"id": string,"is_active": boolean,"offering_id": string,"price": number,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attendance": string,"company_id": string,"country": string,"created_at"?: string,"created_by"?: string | null,"currency": string,"id"?: string,"is_active"?: boolean,"offering_id": string,"price": number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "attendance"?: string,"company_id"?: string,"country"?: string,"created_at"?: string,"created_by"?: string | null,"currency"?: string,"id"?: string,"is_active"?: boolean,"offering_id"?: string,"price"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: []
                },"workshop_price_history": {
                  Row: {
                    "attendance": string,"changed_at": string,"changed_by": string | null,"company_id": string,"country": string,"id": number,"new_active": boolean,"new_currency": string,"new_price": number,"offering_id": string,"old_active": boolean | null,"old_currency": string | null,"old_price": number | null,"price_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attendance": string,"changed_at"?: string,"changed_by"?: string | null,"company_id": string,"country": string,"id"?: number,"new_active": boolean,"new_currency": string,"new_price": number,"offering_id": string,"old_active"?: boolean | null,"old_currency"?: string | null,"old_price"?: number | null,"price_id": string
                  }
                  Update: {
                    "attendance"?: string,"changed_at"?: string,"changed_by"?: string | null,"company_id"?: string,"country"?: string,"id"?: number,"new_active"?: boolean,"new_currency"?: string,"new_price"?: number,"offering_id"?: string,"old_active"?: boolean | null,"old_currency"?: string | null,"old_price"?: number | null,"price_id"?: string
                  }
                  Relationships: []
                },"workshop_groups": {
                  Row: {
                    "attendance": string | null,"capacity": number | null,"company_id": string,"created_at": string,"created_by": string | null,"ends_on": string,"id": string,"is_active": boolean,"name": string,"offering_id": string,"sessions": (string)[],"starts_on": string,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attendance"?: string | null,"capacity"?: number | null,"company_id": string,"created_at"?: string,"created_by"?: string | null,"ends_on": string,"id"?: string,"is_active"?: boolean,"name": string,"offering_id": string,"sessions": (string)[],"starts_on": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "attendance"?: string | null,"capacity"?: number | null,"company_id"?: string,"created_at"?: string,"created_by"?: string | null,"ends_on"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"offering_id"?: string,"sessions"?: (string)[],"starts_on"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: []
                },"workshop_bookings": {
                  Row: {
                    "attendance": string,"cancel_reason": string | null,"cancelled_at": string | null,"cancelled_by": string | null,"company_id": string,"contact_id": string,"country": string,"created_at": string,"created_by": string,"currency": string,"discount_amount": number,"discount_reason": string | null,"discount_type": string,"discount_value": number,"final_price": number,"group_id": string,"id": string,"list_price": number,"note": string | null,"offering_id": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attendance": string,"cancel_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"company_id": string,"contact_id": string,"country": string,"created_at"?: string,"created_by": string,"currency": string,"discount_amount"?: number,"discount_reason"?: string | null,"discount_type"?: string,"discount_value"?: number,"final_price": number,"group_id": string,"id"?: string,"list_price": number,"note"?: string | null,"offering_id": string,"status"?: string
                  }
                  Update: {
                    "attendance"?: string,"cancel_reason"?: string | null,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"company_id"?: string,"contact_id"?: string,"country"?: string,"created_at"?: string,"created_by"?: string,"currency"?: string,"discount_amount"?: number,"discount_reason"?: string | null,"discount_type"?: string,"discount_value"?: number,"final_price"?: number,"group_id"?: string,"id"?: string,"list_price"?: number,"note"?: string | null,"offering_id"?: string,"status"?: string
                  }
                  Relationships: []
                },"booking_discount_requests": {
                  Row: {
                    "company_id": string,"calculated_final": number,"booking_id": string,"applied_final": number | null,"decided_at": string | null,"decided_by": string | null,"decision_note": string | null,"discount_type": string,"discount_value": number,"effective_percent": number,"id": string,"list_price": number,"previous_final": number,"reason": string,"requested_amount": number,"requested_at": string,"requested_by": string,"required_level": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"calculated_final": number,"booking_id": string,"applied_final"?: number | null,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"discount_type": string,"discount_value": number,"effective_percent": number,"id"?: string,"list_price": number,"previous_final": number,"reason": string,"requested_amount": number,"requested_at"?: string,"requested_by": string,"required_level": string,"status"?: string
                  }
                  Update: {
                    "company_id"?: string,"calculated_final"?: number,"booking_id"?: string,"applied_final"?: number | null,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"discount_type"?: string,"discount_value"?: number,"effective_percent"?: number,"id"?: string,"list_price"?: number,"previous_final"?: number,"reason"?: string,"requested_amount"?: number,"requested_at"?: string,"requested_by"?: string,"required_level"?: string,"status"?: string
                  }
                  Relationships: []
                },"company_target_settings": {
                  Row: {
                    "company_id": string,"currency": string,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"currency": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"currency"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: []
                },"company_branding": {
                  Row: {
                    "brand_blue": string,"brand_gold": string,"brand_navy": string,"company_id": string,"logo_plate": boolean,"logo_type": string | null,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "brand_blue"?: string,"brand_gold"?: string,"brand_navy"?: string,"company_id": string,"logo_plate"?: boolean,"logo_type"?: string | null,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "brand_blue"?: string,"brand_gold"?: string,"brand_navy"?: string,"company_id"?: string,"logo_plate"?: boolean,"logo_type"?: string | null,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: []
                },"company_ui_settings": {
                  Row: {
                    "company_id": string,"dashboard_mode": string,"hidden_nav": (string)[],"hidden_widgets": (string)[],"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"dashboard_mode"?: string,"hidden_nav"?: (string)[],"hidden_widgets"?: (string)[],"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"dashboard_mode"?: string,"hidden_nav"?: (string)[],"hidden_widgets"?: (string)[],"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: []
                },"employee_shifts": {
                  Row: {
                    "company_id": string,"created_at": string,"created_by": string | null,"effective_from": string,"effective_to": string | null,"ends_at": string,"id": string,"starts_at": string,"user_id": string,"weekdays": (number)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"created_by"?: string | null,"effective_from": string,"effective_to"?: string | null,"ends_at": string,"id"?: string,"starts_at": string,"user_id": string,"weekdays": (number)[]
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"created_by"?: string | null,"effective_from"?: string,"effective_to"?: string | null,"ends_at"?: string,"id"?: string,"starts_at"?: string,"user_id"?: string,"weekdays"?: (number)[]
                  }
                  Relationships: []
                },"commission_tiers": {
                  Row: {
                    "company_id": string,"min_attainment": number,"rate": number,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"min_attainment": number,"rate": number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"min_attainment"?: number,"rate"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: []
                },"company_offerings": {
                  Row: {
                    "company_id": string,"created_at": string,"id": string,"is_active": boolean,"keywords": (string)[],"sort_order": number | null,"kind": Database["public"]['Enums']["offering_kind"],"name": string,"price_egp": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"keywords"?: (string)[],"sort_order"?: number | null,"kind"?: Database["public"]['Enums']["offering_kind"],"name": string,"price_egp"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"keywords"?: (string)[],"sort_order"?: number | null,"kind"?: Database["public"]['Enums']["offering_kind"],"name"?: string,"price_egp"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_offerings_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"contact_companies": {
                  Row: {
                    "company_id": string,"contact_id": string,"created_at": string,"created_by": string | null,"id": string,"notes": string | null,"owner_id": string | null,"relationship": Database["public"]['Enums']["contact_relationship"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"contact_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"notes"?: string | null,"owner_id"?: string | null,"relationship"?: Database["public"]['Enums']["contact_relationship"],"updated_at"?: string
                  }
                  Update: {
                    "company_id"?: string,"contact_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"notes"?: string | null,"owner_id"?: string | null,"relationship"?: Database["public"]['Enums']["contact_relationship"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contact_companies_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_companies_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_companies_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_companies_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"contact_duplicate_reviews": {
                  Row: {
                    "contact_a_id": string,"contact_b_id": string,"created_at": string,"id": string,"reason": string,"resolved_at": string | null,"resolved_by": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contact_a_id": string,"contact_b_id": string,"created_at"?: string,"id"?: string,"reason": string,"resolved_at"?: string | null,"resolved_by"?: string | null,"status"?: string
                  }
                  Update: {
                    "contact_a_id"?: string,"contact_b_id"?: string,"created_at"?: string,"id"?: string,"reason"?: string,"resolved_at"?: string | null,"resolved_by"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contact_duplicate_reviews_contact_a_id_fkey"
      columns: ["contact_a_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_duplicate_reviews_contact_b_id_fkey"
      columns: ["contact_b_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contact_duplicate_reviews_resolved_by_fkey"
      columns: ["resolved_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"contacts": {
                  Row: {
                    "created_at": string,"created_by": string | null,"email": string | null,"full_name": string,"id": string,"is_sandbox": boolean,"merged_into_id": string | null,"phone_e164": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"email"?: string | null,"full_name": string,"id"?: string,"is_sandbox"?: boolean,"merged_into_id"?: string | null,"phone_e164"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"email"?: string | null,"full_name"?: string,"id"?: string,"is_sandbox"?: boolean,"merged_into_id"?: string | null,"phone_e164"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contacts_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "contacts_merged_into_id_fkey"
      columns: ["merged_into_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    }
                  ]
                },"conversation_assignments": {
                  Row: {
                    "assigned_by": string | null,"conversation_id": string,"created_at": string,"from_user_id": string | null,"id": string,"reason": string | null,"to_user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_by"?: string | null,"conversation_id": string,"created_at"?: string,"from_user_id"?: string | null,"id"?: string,"reason"?: string | null,"to_user_id"?: string | null
                  }
                  Update: {
                    "assigned_by"?: string | null,"conversation_id"?: string,"created_at"?: string,"from_user_id"?: string | null,"id"?: string,"reason"?: string | null,"to_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversation_assignments_assigned_by_fkey"
      columns: ["assigned_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversation_assignments_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversation_leads"
      referencedColumns: ["conversation_id"]
    },{
      foreignKeyName: "conversation_assignments_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversation_assignments_from_user_id_fkey"
      columns: ["from_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversation_assignments_to_user_id_fkey"
      columns: ["to_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"conversation_notes": {
                  Row: {
                    "author_id": string,"body": string,"conversation_id": string,"created_at": string,"id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id": string,"body": string,"conversation_id": string,"created_at"?: string,"id"?: string
                  }
                  Update: {
                    "author_id"?: string,"body"?: string,"conversation_id"?: string,"created_at"?: string,"id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversation_notes_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversation_notes_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversation_leads"
      referencedColumns: ["conversation_id"]
    },{
      foreignKeyName: "conversation_notes_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"conversations": {
                  Row: {
                    "company_id": string,"contact_id": string,"created_at": string,"customer_bsuid": string | null,"customer_wa_id": string | null,"id": string,"is_sandbox": boolean,"is_simulated": boolean,"last_inbound_at": string | null,"last_message_at": string | null,"last_outbound_at": string | null,"owner_id": string | null,"status": Database["public"]['Enums']["conversation_status"],"unread_count": number,"updated_at": string,"whatsapp_account_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"contact_id": string,"created_at"?: string,"customer_bsuid"?: string | null,"customer_wa_id"?: string | null,"id"?: string,"is_sandbox"?: boolean,"is_simulated"?: boolean,"last_inbound_at"?: string | null,"last_message_at"?: string | null,"last_outbound_at"?: string | null,"owner_id"?: string | null,"status"?: Database["public"]['Enums']["conversation_status"],"unread_count"?: number,"updated_at"?: string,"whatsapp_account_id": string
                  }
                  Update: {
                    "company_id"?: string,"contact_id"?: string,"created_at"?: string,"customer_bsuid"?: string | null,"customer_wa_id"?: string | null,"id"?: string,"is_sandbox"?: boolean,"is_simulated"?: boolean,"last_inbound_at"?: string | null,"last_message_at"?: string | null,"last_outbound_at"?: string | null,"owner_id"?: string | null,"status"?: Database["public"]['Enums']["conversation_status"],"unread_count"?: number,"updated_at"?: string,"whatsapp_account_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversations_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversations_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversations_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversations_whatsapp_account_id_fkey"
      columns: ["whatsapp_account_id"]
isOneToOne: false
      referencedRelation: "whatsapp_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"deal_stage_history": {
                  Row: {
                    "changed_by": string | null,"company_id": string,"created_at": string,"deal_id": string,"from_stage_id": string | null,"from_status": Database["public"]['Enums']["deal_status"] | null,"id": string,"to_stage_id": string | null,"to_status": Database["public"]['Enums']["deal_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "changed_by"?: string | null,"company_id": string,"created_at"?: string,"deal_id": string,"from_stage_id"?: string | null,"from_status"?: Database["public"]['Enums']["deal_status"] | null,"id"?: string,"to_stage_id"?: string | null,"to_status": Database["public"]['Enums']["deal_status"]
                  }
                  Update: {
                    "changed_by"?: string | null,"company_id"?: string,"created_at"?: string,"deal_id"?: string,"from_stage_id"?: string | null,"from_status"?: Database["public"]['Enums']["deal_status"] | null,"id"?: string,"to_stage_id"?: string | null,"to_status"?: Database["public"]['Enums']["deal_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_stage_history_changed_by_fkey"
      columns: ["changed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deal_stage_history_deal_id_company_id_fkey"
      columns: ["deal_id","company_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "deal_stage_history_from_stage_id_fkey"
      columns: ["from_stage_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deal_stage_history_to_stage_id_fkey"
      columns: ["to_stage_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id"]
    }
                  ]
                },"deals": {
                  Row: {
                    "amount": number,"archived_at": string | null,"closed_by": string | null,"company_id": string,"contact_id": string,"created_at": string,"created_by": string,"currency": string,"expected_close_date": string | null,"id": string,"lead_id": string | null,"loss_reason": string | null,"lost_at": string | null,"notes": string | null,"owner_id": string | null,"pipeline_id": string,"probability": number | null,"stage_id": string,"status": Database["public"]['Enums']["deal_status"],"title": string,"updated_at": string,"won_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount"?: number,"archived_at"?: string | null,"closed_by"?: string | null,"company_id": string,"contact_id": string,"created_at"?: string,"created_by": string,"currency": string,"expected_close_date"?: string | null,"id"?: string,"lead_id"?: string | null,"loss_reason"?: string | null,"lost_at"?: string | null,"notes"?: string | null,"owner_id"?: string | null,"pipeline_id": string,"probability"?: number | null,"stage_id": string,"status"?: Database["public"]['Enums']["deal_status"],"title": string,"updated_at"?: string,"won_at"?: string | null
                  }
                  Update: {
                    "amount"?: number,"archived_at"?: string | null,"closed_by"?: string | null,"company_id"?: string,"contact_id"?: string,"created_at"?: string,"created_by"?: string,"currency"?: string,"expected_close_date"?: string | null,"id"?: string,"lead_id"?: string | null,"loss_reason"?: string | null,"lost_at"?: string | null,"notes"?: string | null,"owner_id"?: string | null,"pipeline_id"?: string,"probability"?: number | null,"stage_id"?: string,"status"?: Database["public"]['Enums']["deal_status"],"title"?: string,"updated_at"?: string,"won_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "deals_closed_by_fkey"
      columns: ["closed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_lead_id_company_id_fkey"
      columns: ["lead_id","company_id"]
isOneToOne: false
      referencedRelation: "leads"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "deals_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_pipeline_id_company_id_fkey"
      columns: ["pipeline_id","company_id"]
isOneToOne: false
      referencedRelation: "pipelines"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "deals_stage_id_pipeline_id_fkey"
      columns: ["stage_id","pipeline_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id","pipeline_id"]
    }
                  ]
                },"lead_assignments": {
                  Row: {
                    "assigned_by": string | null,"company_id": string,"created_at": string,"from_user_id": string | null,"id": string,"lead_id": string,"reason": string | null,"team_id": string | null,"to_user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_by"?: string | null,"company_id": string,"created_at"?: string,"from_user_id"?: string | null,"id"?: string,"lead_id": string,"reason"?: string | null,"team_id"?: string | null,"to_user_id"?: string | null
                  }
                  Update: {
                    "assigned_by"?: string | null,"company_id"?: string,"created_at"?: string,"from_user_id"?: string | null,"id"?: string,"lead_id"?: string,"reason"?: string | null,"team_id"?: string | null,"to_user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "lead_assignments_assigned_by_fkey"
      columns: ["assigned_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "lead_assignments_from_user_id_fkey"
      columns: ["from_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "lead_assignments_lead_id_company_id_fkey"
      columns: ["lead_id","company_id"]
isOneToOne: false
      referencedRelation: "leads"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "lead_assignments_team_id_fkey"
      columns: ["team_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "lead_assignments_to_user_id_fkey"
      columns: ["to_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"lead_status_history": {
                  Row: {
                    "changed_by": string | null,"company_id": string,"created_at": string,"from_status": Database["public"]['Enums']["lead_status"] | null,"id": string,"lead_id": string,"to_status": Database["public"]['Enums']["lead_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "changed_by"?: string | null,"company_id": string,"created_at"?: string,"from_status"?: Database["public"]['Enums']["lead_status"] | null,"id"?: string,"lead_id": string,"to_status": Database["public"]['Enums']["lead_status"]
                  }
                  Update: {
                    "changed_by"?: string | null,"company_id"?: string,"created_at"?: string,"from_status"?: Database["public"]['Enums']["lead_status"] | null,"id"?: string,"lead_id"?: string,"to_status"?: Database["public"]['Enums']["lead_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "lead_status_history_changed_by_fkey"
      columns: ["changed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "lead_status_history_lead_id_company_id_fkey"
      columns: ["lead_id","company_id"]
isOneToOne: false
      referencedRelation: "leads"
      referencedColumns: ["id","company_id"]
    }
                  ]
                },"leads": {
                  Row: {
                    "archived_at": string | null,"archived_by": string | null,"auto_created": boolean,"campaign": string | null,"company_id": string,"contact_id": string,"conversation_id": string | null,"created_at": string,"created_by": string | null,"estimated_value": number | null,"first_contacted_at": string | null,"id": string,"interest": Database["public"]['Enums']["lead_interest"],"is_sandbox": boolean,"last_activity_at": string | null,"next_follow_up_at": string | null,"notes": string | null,"offering_id": string | null,"offering_source": string | null,"owner_id": string | null,"priority": Database["public"]['Enums']["priority_level"],"qualification": NonNullable<Json>,"referral_source": string | null,"source": Database["public"]['Enums']["lead_source"],"stage_id": string | null,"status": Database["public"]['Enums']["lead_status"],"team_id": string | null,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"archived_by"?: string | null,"auto_created"?: boolean,"campaign"?: string | null,"company_id": string,"contact_id": string,"conversation_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"estimated_value"?: number | null,"first_contacted_at"?: string | null,"id"?: string,"interest"?: Database["public"]['Enums']["lead_interest"],"is_sandbox"?: boolean,"last_activity_at"?: string | null,"next_follow_up_at"?: string | null,"notes"?: string | null,"offering_id"?: string | null,"offering_source"?: string | null,"owner_id"?: string | null,"priority"?: Database["public"]['Enums']["priority_level"],"qualification"?: NonNullable<Json>,"referral_source"?: string | null,"source"?: Database["public"]['Enums']["lead_source"],"stage_id"?: string | null,"status"?: Database["public"]['Enums']["lead_status"],"team_id"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"archived_by"?: string | null,"auto_created"?: boolean,"campaign"?: string | null,"company_id"?: string,"contact_id"?: string,"conversation_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"estimated_value"?: number | null,"first_contacted_at"?: string | null,"id"?: string,"interest"?: Database["public"]['Enums']["lead_interest"],"is_sandbox"?: boolean,"last_activity_at"?: string | null,"next_follow_up_at"?: string | null,"notes"?: string | null,"offering_id"?: string | null,"offering_source"?: string | null,"owner_id"?: string | null,"priority"?: Database["public"]['Enums']["priority_level"],"qualification"?: NonNullable<Json>,"referral_source"?: string | null,"source"?: Database["public"]['Enums']["lead_source"],"stage_id"?: string | null,"status"?: Database["public"]['Enums']["lead_status"],"team_id"?: string | null,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "leads_archived_by_fkey"
      columns: ["archived_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "leads_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "leads_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "leads_conversation_fk"
      columns: ["conversation_id","company_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "leads_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "leads_offering_fk"
      columns: ["offering_id","company_id"]
isOneToOne: false
      referencedRelation: "company_offerings"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "leads_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "leads_stage_id_fkey"
      columns: ["stage_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "leads_team_id_company_id_fkey"
      columns: ["team_id","company_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id","company_id"]
    }
                  ]
                },"message_media_cache": {
                  Row: {
                    "cached_at": string,"message_id": string,"mime_type": string,"size_bytes": number,"storage_path": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cached_at"?: string,"message_id": string,"mime_type": string,"size_bytes": number,"storage_path": string
                  }
                  Update: {
                    "cached_at"?: string,"message_id"?: string,"mime_type"?: string,"size_bytes"?: number,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "message_media_cache_message_id_fkey"
      columns: ["message_id"]
isOneToOne: true
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"messages": {
                  Row: {
                    "body": string | null,"client_request_id": string | null,"conversation_id": string,"created_at": string,"direction": Database["public"]['Enums']["message_direction"],"error_code": string | null,"error_message": string | null,"id": string,"is_sandbox": boolean,"is_simulated": boolean,"media": Json | null,"message_type": string,"sent_at": string,"sent_by": string | null,"status": Database["public"]['Enums']["message_status"],"status_updated_at": string | null,"wa_message_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"client_request_id"?: string | null,"conversation_id": string,"created_at"?: string,"direction": Database["public"]['Enums']["message_direction"],"error_code"?: string | null,"error_message"?: string | null,"id"?: string,"is_sandbox"?: boolean,"is_simulated"?: boolean,"media"?: Json | null,"message_type"?: string,"sent_at"?: string,"sent_by"?: string | null,"status": Database["public"]['Enums']["message_status"],"status_updated_at"?: string | null,"wa_message_id"?: string | null
                  }
                  Update: {
                    "body"?: string | null,"client_request_id"?: string | null,"conversation_id"?: string,"created_at"?: string,"direction"?: Database["public"]['Enums']["message_direction"],"error_code"?: string | null,"error_message"?: string | null,"id"?: string,"is_sandbox"?: boolean,"is_simulated"?: boolean,"media"?: Json | null,"message_type"?: string,"sent_at"?: string,"sent_by"?: string | null,"status"?: Database["public"]['Enums']["message_status"],"status_updated_at"?: string | null,"wa_message_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversation_leads"
      referencedColumns: ["conversation_id"]
    },{
      foreignKeyName: "messages_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_sent_by_fkey"
      columns: ["sent_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "body": string | null,"company_id": string | null,"created_at": string,"dedupe_key": string | null,"entity_id": string | null,"entity_type": string | null,"id": string,"read_at": string | null,"title": string,"type": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"company_id"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: string,"read_at"?: string | null,"title": string,"type": string,"user_id": string
                  }
                  Update: {
                    "body"?: string | null,"company_id"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: string,"read_at"?: string | null,"title"?: string,"type"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"pipeline_stages": {
                  Row: {
                    "company_id": string,"created_at": string,"id": string,"is_active": boolean,"name": string,"pipeline_id": string,"position": number,"probability": number | null,"stage_type": Database["public"]['Enums']["stage_type"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"pipeline_id": string,"position": number,"probability"?: number | null,"stage_type"?: Database["public"]['Enums']["stage_type"],"updated_at"?: string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"pipeline_id"?: string,"position"?: number,"probability"?: number | null,"stage_type"?: Database["public"]['Enums']["stage_type"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pipeline_stages_pipeline_id_company_id_fkey"
      columns: ["pipeline_id","company_id"]
isOneToOne: false
      referencedRelation: "pipelines"
      referencedColumns: ["id","company_id"]
    }
                  ]
                },"pipelines": {
                  Row: {
                    "company_id": string,"created_at": string,"id": string,"is_active": boolean,"is_default": boolean,"kind": Database["public"]['Enums']["pipeline_kind"],"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"kind"?: Database["public"]['Enums']["pipeline_kind"],"name": string,"updated_at"?: string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"is_default"?: boolean,"kind"?: Database["public"]['Enums']["pipeline_kind"],"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pipelines_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"deactivated_at": string | null,"deactivated_by": string | null,"email": string | null,"full_name": string,"id": string,"is_active": boolean,"is_super_admin": boolean,"locale": string,"phone": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"deactivated_at"?: string | null,"deactivated_by"?: string | null,"email"?: string | null,"full_name"?: string,"id": string,"is_active"?: boolean,"is_super_admin"?: boolean,"locale"?: string,"phone"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"deactivated_at"?: string | null,"deactivated_by"?: string | null,"email"?: string | null,"full_name"?: string,"id"?: string,"is_active"?: boolean,"is_super_admin"?: boolean,"locale"?: string,"phone"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_deactivated_by_fkey"
      columns: ["deactivated_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"sales_targets": {
                  Row: {
                    "company_id": string,"created_at": string,"created_by": string | null,"id": string,"metric": Database["public"]['Enums']["target_metric"],"period_end": string,"period_start": string,"target_value": number,"team_id": string | null,"updated_at": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"metric": Database["public"]['Enums']["target_metric"],"period_end": string,"period_start": string,"target_value": number,"team_id"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"metric"?: Database["public"]['Enums']["target_metric"],"period_end"?: string,"period_start"?: string,"target_value"?: number,"team_id"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sales_targets_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_targets_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sales_targets_team_id_company_id_fkey"
      columns: ["team_id","company_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "sales_targets_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "assigned_to": string | null,"canceled_at": string | null,"company_id": string,"completed_at": string | null,"completed_by": string | null,"contact_id": string | null,"created_at": string,"created_by": string,"deal_id": string | null,"description": string | null,"due_at": string | null,"id": string,"lead_id": string | null,"outcome": string | null,"priority": Database["public"]['Enums']["priority_level"],"status": Database["public"]['Enums']["task_status"],"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "assigned_to"?: string | null,"canceled_at"?: string | null,"company_id": string,"completed_at"?: string | null,"completed_by"?: string | null,"contact_id"?: string | null,"created_at"?: string,"created_by": string,"deal_id"?: string | null,"description"?: string | null,"due_at"?: string | null,"id"?: string,"lead_id"?: string | null,"outcome"?: string | null,"priority"?: Database["public"]['Enums']["priority_level"],"status"?: Database["public"]['Enums']["task_status"],"title": string,"updated_at"?: string
                  }
                  Update: {
                    "assigned_to"?: string | null,"canceled_at"?: string | null,"company_id"?: string,"completed_at"?: string | null,"completed_by"?: string | null,"contact_id"?: string | null,"created_at"?: string,"created_by"?: string,"deal_id"?: string | null,"description"?: string | null,"due_at"?: string | null,"id"?: string,"lead_id"?: string | null,"outcome"?: string | null,"priority"?: Database["public"]['Enums']["priority_level"],"status"?: Database["public"]['Enums']["task_status"],"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_assigned_to_fkey"
      columns: ["assigned_to"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_completed_by_fkey"
      columns: ["completed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_contact_id_fkey"
      columns: ["contact_id"]
isOneToOne: false
      referencedRelation: "contacts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_deal_id_company_id_fkey"
      columns: ["deal_id","company_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "tasks_lead_id_company_id_fkey"
      columns: ["lead_id","company_id"]
isOneToOne: false
      referencedRelation: "leads"
      referencedColumns: ["id","company_id"]
    }
                  ]
                },"team_memberships": {
                  Row: {
                    "company_id": string,"created_at": string,"created_by": string | null,"team_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"created_by"?: string | null,"team_id": string,"user_id": string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"created_by"?: string | null,"team_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "team_memberships_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "team_memberships_team_id_company_id_fkey"
      columns: ["team_id","company_id"]
isOneToOne: false
      referencedRelation: "teams"
      referencedColumns: ["id","company_id"]
    },{
      foreignKeyName: "team_memberships_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"teams": {
                  Row: {
                    "company_id": string,"created_at": string,"created_by": string | null,"id": string,"is_active": boolean,"manager_id": string | null,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "company_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"is_active"?: boolean,"manager_id"?: string | null,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "company_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"is_active"?: boolean,"manager_id"?: string | null,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "teams_company_id_fkey"
      columns: ["company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "teams_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "teams_manager_id_fkey"
      columns: ["manager_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"whatsapp_account_access": {
                  Row: {
                    "can_reply": boolean,"created_at": string,"granted_by": string | null,"user_id": string,"whatsapp_account_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "can_reply"?: boolean,"created_at"?: string,"granted_by"?: string | null,"user_id": string,"whatsapp_account_id": string
                  }
                  Update: {
                    "can_reply"?: boolean,"created_at"?: string,"granted_by"?: string | null,"user_id"?: string,"whatsapp_account_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "whatsapp_account_access_granted_by_fkey"
      columns: ["granted_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "whatsapp_account_access_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "whatsapp_account_access_whatsapp_account_id_fkey"
      columns: ["whatsapp_account_id"]
isOneToOne: false
      referencedRelation: "whatsapp_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"whatsapp_account_health": {
                  Row: {
                    "checked_at": string,"error_code": string | null,"failing_since": string | null,"status": string,"whatsapp_account_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "checked_at"?: string,"error_code"?: string | null,"failing_since"?: string | null,"status": string,"whatsapp_account_id": string
                  }
                  Update: {
                    "checked_at"?: string,"error_code"?: string | null,"failing_since"?: string | null,"status"?: string,"whatsapp_account_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "whatsapp_account_health_whatsapp_account_id_fkey"
      columns: ["whatsapp_account_id"]
isOneToOne: true
      referencedRelation: "whatsapp_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"whatsapp_accounts": {
                  Row: {
                    "created_at": string,"created_by": string | null,"default_company_id": string,"display_name": string,"environment": string,"connection_mode": string | null,"connection_state": string,"outbound_enabled": boolean,"id": string,"is_sandbox": boolean,"is_simulated": boolean,"phone_e164": string,"phone_number_id": string | null,"provider": string,"status": Database["public"]['Enums']["wa_account_status"],"updated_at": string,"waba_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"default_company_id": string,"display_name": string,"environment"?: string,"connection_mode"?: string | null,"connection_state"?: string,"outbound_enabled"?: boolean,"id"?: string,"is_sandbox"?: boolean,"is_simulated"?: boolean,"phone_e164": string,"phone_number_id"?: string | null,"provider"?: string,"status"?: Database["public"]['Enums']["wa_account_status"],"updated_at"?: string,"waba_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"default_company_id"?: string,"display_name"?: string,"environment"?: string,"connection_mode"?: string | null,"connection_state"?: string,"outbound_enabled"?: boolean,"id"?: string,"is_sandbox"?: boolean,"is_simulated"?: boolean,"phone_e164"?: string,"phone_number_id"?: string | null,"provider"?: string,"status"?: Database["public"]['Enums']["wa_account_status"],"updated_at"?: string,"waba_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "whatsapp_accounts_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "whatsapp_accounts_default_company_id_fkey"
      columns: ["default_company_id"]
isOneToOne: false
      referencedRelation: "companies"
      referencedColumns: ["id"]
    }
                  ]
                },"whatsapp_templates": {
                  Row: {
                    "body_text": string,"category": string,"components": NonNullable<Json>,"id": string,"language": string,"name": string,"param_count": number,"status": string,"supported": boolean | null,"synced_at": string,"whatsapp_account_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body_text"?: string,"category"?: string,"components"?: NonNullable<Json>,"id"?: string,"language": string,"name": string,"param_count"?: number,"status": string,"supported"?: never,"synced_at"?: string,"whatsapp_account_id": string
                  }
                  Update: {
                    "body_text"?: string,"category"?: string,"components"?: NonNullable<Json>,"id"?: string,"language"?: string,"name"?: string,"param_count"?: number,"status"?: string,"supported"?: never,"synced_at"?: string,"whatsapp_account_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "whatsapp_templates_whatsapp_account_id_fkey"
      columns: ["whatsapp_account_id"]
isOneToOne: false
      referencedRelation: "whatsapp_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"whatsapp_webhook_events": {
                  Row: {
                    "attempts": number,"event_key": string,"event_kind": string,"id": string,"last_error": string | null,"payload": NonNullable<Json>,"phone_number_id": string | null,"processed_at": string | null,"received_at": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"event_key": string,"event_kind": string,"id"?: string,"last_error"?: string | null,"payload": NonNullable<Json>,"phone_number_id"?: string | null,"processed_at"?: string | null,"received_at"?: string,"status"?: string
                  }
                  Update: {
                    "attempts"?: number,"event_key"?: string,"event_kind"?: string,"id"?: string,"last_error"?: string | null,"payload"?: NonNullable<Json>,"phone_number_id"?: string | null,"processed_at"?: string | null,"received_at"?: string,"status"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "conversation_leads": {
                  Row: {
                    "auto_created": boolean | null,"conversation_id": string | null,"interest": Database["public"]['Enums']["lead_interest"] | null,"lead_id": string | null,"lead_owner_id": string | null,"lead_status": Database["public"]['Enums']["lead_status"] | null,"linked": boolean | null,"offering_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "leads_owner_id_fkey"
      columns: ["lead_owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "apply_kapso_status":
{ Args: { "p_body"?: string,"p_error_code"?: string,"p_error_message"?: string,"p_media"?: Json,"p_message_type"?: string,"p_phone_number_id": string,"p_sent_at"?: string,"p_status": string,"p_to_wa_id"?: string,"p_wa_message_id": string }; Returns: boolean
                           },
"apply_whatsapp_status":
{ Args: { "p_error_code"?: string,"p_error_message"?: string,"p_status": string,"p_wa_message_id": string }; Returns: boolean
                           },
"assign_conversation":
{ Args: { "p_conversation_id": string,"p_owner_id": string,"p_reason"?: string }; Returns: undefined
                           },
"assign_lead":
{ Args: { "p_lead_id": string,"p_owner_id": string,"p_reason"?: string,"p_team_id"?: string }; Returns: undefined
                           },
"claim_webhook_event":
{ Args: { "p_event_key": string,"p_event_kind": string,"p_payload": Json,"p_phone_number_id": string }; Returns: string
                           },
"convert_lead_to_deal":
{ Args: { "p_amount"?: number,"p_expected_close_date"?: string,"p_lead_id": string,"p_owner_id"?: string,"p_pipeline_id"?: string,"p_stage_id"?: string,"p_title"?: string }; Returns: string
                           },
"create_pipeline":
{ Args: { "p_company_id": string,"p_kind": Database["public"]['Enums']["pipeline_kind"],"p_name": string }; Returns: string
                           },
"dismiss_duplicate_review":
{ Args: { "p_review_id": string }; Returns: undefined
                           },
"payment_balance":
{ Args: { "p_contact_id": string,"p_offering_id": string }; Returns: {
              "confirmed_egp": number,"pending_egp": number,"price_egp": number | null
            }[]
                           },
"report_monthly_commission":
{ Args: { "p_company_id": string,"p_month"?: string }; Returns: {
              "achieved_amount": number,"achieved_customers": number,"amount_attainment": number | null,"commission_egp": number,"customers_attainment": number | null,"full_name": string,"pending_amount": number,"rate": number,"target_amount": number | null,"target_customers": number | null,"target_currency": string,"target_source": string | null,"tier_min": number | null,"user_id": string
            }[]
                           },
"set_commission_tiers":
{ Args: { "p_company_id": string,"p_tiers": Json }; Returns: number
                           },
"set_monthly_target":
{ Args: { "p_amount_egp": number | null,"p_company_id": string,"p_customers": number | null,"p_month": string,"p_user_id": string }; Returns: undefined
                           },
"record_payment":
{ Args: { "p_amount": number,"p_contact_id": string,"p_currency": string,"p_kind": string,"p_note"?: string,"p_offering_id": string,"p_paid_on"?: string }; Returns: string
                           },
"review_payment":
{ Args: { "p_decision": string,"p_id": string,"p_note"?: string }; Returns: undefined
                           },
"upsert_fx_rates":
{ Args: { "p_rates": Json,"p_source": string }; Returns: number
                           },
"find_or_create_contact":
{ Args: { "p_company_id": string,"p_email"?: string,"p_full_name": string,"p_phone_e164"?: string }; Returns: {
              "contact_id": string,"matched_existing": boolean,"open_leads_in_company": number,"possible_duplicates": number
            }[]
                           },
"finish_webhook_event":
{ Args: { "p_error"?: string,"p_event_key": string,"p_status": string }; Returns: undefined
                           },
"generate_task_reminders":
{ Args: { "p_now"?: string }; Returns: number
                           },
"global_search":
{ Args: { "p_company_ids"?: (string)[],"p_limit"?: number,"p_query": string }; Returns: {
              "company_id": string,"entity_id": string,"entity_type": string,"status": string,"subtitle": string,"title": string,"updated_at": string
            }[]
                           },
"import_leads":
{ Args: { "p_company_id": string,"p_rows": Json }; Returns: {
              "contact_id": string,"error_key": string,"lead_id": string,"matched_existing": boolean,"row_index": number
            }[]
                           },
"ingest_kapso_echo":
{ Args: { "p_body": string,"p_media": Json,"p_message_type": string,"p_phone_number_id": string,"p_sent_at": string,"p_to_wa_id": string,"p_wa_message_id": string }; Returns: {
              "conversation_id": string,"duplicate": boolean,"message_id": string
            }[]
                           },
"ingest_kapso_message":
{ Args: { "p_body": string,"p_from_wa_id": string,"p_media": Json,"p_message_type": string,"p_phone_number_id": string,"p_profile_name": string,"p_sent_at": string,"p_wa_message_id": string }; Returns: {
              "conversation_id": string,"duplicate": boolean,"message_id": string
            }[]
                           },
"ingest_whatsapp_echo":
{ Args: { "p_body": string,"p_media": Json,"p_message_type": string,"p_phone_number_id": string,"p_sent_at": string,"p_to_wa_id": string,"p_wa_message_id": string }; Returns: {
              "conversation_id": string,"duplicate": boolean,"message_id": string
            }[]
                           },
"ingest_whatsapp_message":
{ Args: { "p_body": string,"p_from_wa_id": string,"p_media": Json,"p_message_type": string,"p_phone_number_id": string,"p_profile_name": string,"p_sent_at": string,"p_wa_message_id": string }; Returns: {
              "conversation_id": string,"duplicate": boolean,"message_id": string
            }[]
                           },
"job_status":
{ Args: Record<PropertyKey, never>; Returns: {
              "failures_24h": number,"job": string,"last_details": Json,"last_error": string,"last_finished_at": string,"last_ok": boolean,"last_started_at": string,"runs_24h": number
            }[]
                           },
"lead_from_conversation":
{ Args: { "p_conversation_id": string }; Returns: {
              "created": boolean,"lead_id": string
            }[]
                           },
"mark_notifications_read":
{ Args: { "p_ids"?: (string)[] }; Returns: number
                           },
"merge_contacts":
{ Args: { "p_keep_id": string,"p_merge_id": string }; Returns: undefined
                           },
"move_conversation_company":
{ Args: { "p_company_id": string,"p_conversation_id": string,"p_reason": string }; Returns: undefined
                           },
"pending_webhook_retries":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number }; Returns: {
              "attempts": number,"event_key": string,"event_kind": string,"payload": Json
            }[]
                           },
"process_webhook_retries":
{ Args: { "p_limit"?: number,"p_max_attempts"?: number }; Returns: Json
                           },
"purge_old_webhook_events":
{ Args: { "p_days"?: number }; Returns: number
                           },
"purge_rate_limits":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"queue_outbound":
{ Args: { "p_body"?: string,"p_client_request_id": string,"p_conversation_id": string,"p_media"?: Json,"p_message_type": string,"p_template"?: Json }; Returns: {
              "already_queued": boolean,"message_id": string,"phone_number_id": string,"to_wa_id": string
            }[]
                           },
"queue_outbound_message":
{ Args: { "p_body": string,"p_client_request_id": string,"p_conversation_id": string }; Returns: {
              "already_queued": boolean,"message_id": string,"phone_number_id": string,"to_wa_id": string
            }[]
                           },
"rate_limit_hit":
{ Args: { "p_action": string,"p_key": string,"p_limit": number,"p_window_seconds": number }; Returns: boolean
                           },
"record_outbound_result":
{ Args: { "p_error_code"?: string,"p_error_message"?: string,"p_message_id": string,"p_wa_message_id": string }; Returns: undefined
                           },
"record_outbound_unconfirmed":
{ Args: { "p_message_id": string }; Returns: undefined
                           },
"reorder_pipeline_stages":
{ Args: { "p_pipeline_id": string,"p_stage_ids": (string)[] }; Returns: undefined
                           },
"report_company_kpis":
{ Args: { "p_company_ids"?: (string)[],"p_from": string,"p_team_id"?: string,"p_to": string,"p_user_id"?: string }; Returns: {
              "activities_logged": number,"company_id": string,"company_name": string,"currency": string,"deals_lost": number,"deals_won": number,"lead_conversion_rate": number,"leads_converted": number,"leads_created": number,"open_deals": number,"open_leads": number,"open_pipeline_value": number,"overdue_tasks": number,"tasks_completed": number,"weighted_pipeline_value": number,"win_rate": number,"won_revenue": number
            }[]
                           },
"report_daily_series":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string,"p_user_id"?: string }; Returns: {
              "calls_logged": number,"day": string,"deals_won": number,"leads_created": number,"tasks_completed": number,"won_revenue": number
            }[]
                           },
"report_employee_performance":
{ Args: { "p_company_id": string,"p_from": string,"p_team_id"?: string,"p_to": string }; Returns: {
              "calls_logged": number,"deals_created": number,"deals_lost": number,"deals_won": number,"follow_ups_completed": number,"full_name": string,"leads_assigned": number,"leads_contacted": number,"leads_created": number,"meetings_logged": number,"overdue_tasks": number,"sign_ins": number,"user_id": string,"whatsapp_replies": number,"win_rate": number,"won_revenue": number
            }[]
                           },
"can_review_payments":
{ Args: { "p_company_id": string }; Returns: boolean
                           },
"clear_payment_approval_policy":
{ Args: { "p_company_id": string }; Returns: undefined
                           },
"set_payment_approvers":
{ Args: { "p_company_id": string,"p_user_ids": (string)[] }; Returns: number
                           },
"set_performance_exclusion":
{ Args: { "p_company_id": string,"p_excluded": boolean,"p_reason"?: string,"p_user_id": string }; Returns: undefined
                           },
"set_workshop_price":
{ Args: { "p_attendance": string,"p_country": string,"p_currency": string,"p_offering_id": string,"p_price": number }; Returns: string
                           },
"report_response_log":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string }; Returns: { "answered_at": string | null,"answered_by": string | null,"answered_by_name": string | null,"asked_at": string,"contact_name": string,"conversation_id": string,"crm_repliers": string | null,"owner_name": string | null,"phone": string | null,"wait_seconds": number }[]
                           },
"save_company_role":
{ Args: { "p_base_role": Database["public"]['Enums']["app_role"],"p_company_id": string,"p_hidden_nav": (string)[],"p_id": string,"p_name": string,"p_permissions": Json }; Returns: string
                           },
"delete_company_role":
{ Args: { "p_id": string }; Returns: undefined
                           },
"set_offering_order":
{ Args: { "p_company_id": string,"p_ids": (string)[] }; Returns: number
                           },
"set_workshop_group":
{ Args: { "p_active"?: boolean,"p_attendance": string,"p_capacity": number,"p_group_id": string,"p_name": string,"p_offering_id": string,"p_sessions": (string)[] }; Returns: string
                           },
"workshop_price_for":
{ Args: { "p_attendance": string,"p_country": string,"p_offering_id": string }; Returns: {
              "currency": string,"price": number
            }[]
                           },
"workshop_price_gaps":
{ Args: { "p_company_id": string,"p_countries": (string)[] }; Returns: {
              "attendance": string,"country": string,"offering_id": string,"offering_name": string
            }[]
                           },
"create_workshop_booking":
{ Args: { "p_attendance": string,"p_contact_id": string,"p_country": string,"p_discount_reason"?: string,"p_discount_type"?: string,"p_discount_value"?: number,"p_group_id": string,"p_note"?: string }; Returns: string
                           },
"cancel_workshop_booking":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"record_booking_payment":
{ Args: { "p_amount": number,"p_booking_id": string,"p_note"?: string,"p_paid_on"?: string }; Returns: string
                           },
"request_booking_discount":
{ Args: { "p_booking_id": string,"p_reason": string,"p_type": string,"p_value": number }; Returns: string
                           },
"approve_booking_discount":
{ Args: { "p_note"?: string,"p_request_id": string }; Returns: undefined
                           },
"reject_booking_discount":
{ Args: { "p_reason": string,"p_request_id": string }; Returns: undefined
                           },
"booking_detail":
{ Args: { "p_booking_id": string }; Returns: {
              "attendance": string,"booked_at": string,"booking_id": string,"booking_status": string,"confirmed": number,"contact_id": string,"country": string,"currency": string,"customer_name": string,"discount_amount": number,"discount_reason": string | null,"discount_status": string,"discount_type": string,"discount_value": number,"email": string | null,"final_price": number,"group_id": string,"group_name": string,"group_starts_on": string,"list_price": number,"offering_id": string,"offering_name": string,"payment_status": string,"pending": number,"phone": string | null,"recorded_by": string,"rejected": number,"remaining": number,"request_id": string | null,"requested_amount": number | null,"requested_by_name": string | null,"requested_final": number | null,"requested_percent": number | null,"requested_type": string | null,"requested_value": number | null,"required_level": string | null
            }[]
                           },
"workshop_bookings_list":
{ Args: { "p_group_id"?: string,"p_offering_id": string }; Returns: {
              "attendance": string,"booked_at": string,"booking_id": string,"booking_status": string,"confirmed": number,"contact_id": string,"country": string,"currency": string,"customer_name": string,"discount_amount": number,"discount_reason": string | null,"discount_status": string,"discount_type": string,"discount_value": number,"email": string | null,"final_price": number,"group_id": string,"group_name": string,"group_starts_on": string,"list_price": number,"offering_id": string,"offering_name": string,"payment_status": string,"pending": number,"phone": string | null,"recorded_by": string,"rejected": number,"remaining": number,"request_id": string | null,"requested_amount": number | null,"requested_by_name": string | null,"requested_final": number | null,"requested_percent": number | null,"requested_type": string | null,"requested_value": number | null,"required_level": string | null
            }[]
                           },
"booking_payments":
{ Args: { "p_booking_id": string }; Returns: {
              "amount": number,"amount_egp": number,"created_at": string,"currency": string,"kind": string,"note": string | null,"paid_on": string,"payment_id": string,"recorded_by": string,"review_note": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"status": string
            }[]
                           },
"customer_payment_rows":
{ Args: { "p_company_id": string,"p_contact_id"?: string,"p_currency"?: string,"p_from"?: string,"p_group_id"?: string,"p_offering_id"?: string,"p_status"?: string,"p_to"?: string }; Returns: {
              "attendance": string,"booked_at": string,"booking_id": string,"booking_status": string,"confirmed": number,"contact_id": string,"country": string,"currency": string,"customer_name": string,"discount_amount": number,"discount_status": string,"final_price": number,"group_id": string,"group_name": string,"list_price": number,"offering_id": string,"offering_name": string,"payment_status": string,"pending": number,"phone": string | null,"rejected": number,"remaining": number
            }[]
                           },
"workshop_stats":
{ Args: { "p_offering_id": string }; Returns: {
              "active_bookings": number,"by_currency": Json,"cancelled_bookings": number,"customers": number,"discounted_bookings": number,"online_participants": number,"offline_participants": number,"paid": number,"partially_paid": number,"pending_approval": number,"pending_discounts": number,"rejected": number,"rejected_discounts": number,"total_bookings": number,"unpaid": number
            }[]
                           },
"workshop_group_stats":
{ Args: { "p_offering_id": string }; Returns: {
              "booked": number,"capacity": number | null,"group_id": string,"group_name": string,"is_active": boolean,"starts_on": string
            }[]
                           },
"discount_requests_list":
{ Args: { "p_company_id": string,"p_status"?: string }; Returns: {
              "booking_id": string,"calculated_final": number,"can_decide": boolean,"currency": string,"customer_name": string,"decided_at": string | null,"decided_by_name": string | null,"decision_note": string | null,"discount_type": string,"discount_value": number,"effective_percent": number,"group_name": string,"is_mine": boolean,"list_price": number,"offering_name": string,"previous_final": number,"reason": string,"request_id": string,"requested_amount": number,"requested_at": string,"requested_by_name": string,"required_level": string,"status": string
            }[]
                           },
"company_target_currency":
{ Args: { "p_company_id": string }; Returns: string
                           },
"set_company_target_currency":
{ Args: { "p_company_id": string,"p_currency": string }; Returns: undefined
                           },
"set_employee_shift":
{ Args: { "p_company_id": string,"p_ends": string,"p_from"?: string,"p_starts": string,"p_user_id": string,"p_weekdays": (number)[] }; Returns: string
                           },
"clear_employee_shift":
{ Args: { "p_company_id": string,"p_to"?: string,"p_user_id": string }; Returns: undefined
                           },
"report_shift_activity":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string,"p_user_id"?: string }; Returns: {
              "activities_in": number,"activities_out": number,"bookings_in": number,"bookings_out": number,"day": string,"first_activity": string | null,"full_name": string,"in_shift": number,"last_activity": string | null,"leads_in": number,"leads_out": number,"out_of_shift": number,"payments_in": number,"payments_out": number,"replies_in": number,"replies_out": number,"shift_ends": string | null,"shift_starts": string | null,"user_id": string,"working_day": boolean
            }[]
                           },
"report_workshop_kpis":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string,"p_user_id"?: string }; Returns: {
              "booked_value": number | null,"bookings": number,"cancelled": number | null,"collected": number | null,"currency": string | null,"customers": number | null,"discount_total": number | null,"leads_booked": number | null,"leads_created": number | null,"list_value": number | null,"pending": number | null,"remaining": number | null
            }[]
                           },
"report_workshop_daily":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string,"p_user_id"?: string }; Returns: {
              "booked_value": number,"bookings": number,"collected": number,"currency": string,"day": string
            }[]
                           },
"report_workshop_breakdown":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string,"p_user_id"?: string }; Returns: {
              "booked_value": number,"bookings": number,"collected": number,"currency": string,"offering_id": string,"offering_name": string,"remaining": number
            }[]
                           },
"kapso_import_history":
{ Args: { "p_phone_number_id": string,"p_rows": Json }; Returns: Json
                           },
"set_company_ui_settings_v2":
{ Args: { "p_company_id": string,"p_dashboard_mode": string,"p_hidden_nav": (string)[],"p_hidden_widgets": (string)[] }; Returns: undefined
                           },
"set_company_ui_settings":
{ Args: { "p_company_id": string,"p_dashboard_mode": string,"p_hidden_nav": (string)[] }; Returns: undefined
                           },
"set_company_branding":
{ Args: { "p_blue": string,"p_company_id": string,"p_gold": string,"p_logo_plate": boolean,"p_navy": string }; Returns: undefined
                           },
"set_company_logo":
{ Args: { "p_company_id": string,"p_logo": string,"p_type": string }; Returns: undefined
                           },
"reset_company_branding":
{ Args: { "p_company_id": string }; Returns: undefined
                           },
"company_logo":
{ Args: { "p_company_id": string }; Returns: { "logo": string,"logo_type": string,"updated_at": string }[]
                           },
"touch_presence":
{ Args: { "p_company_id": string }; Returns: undefined
                           },
"report_employee_day":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string,"p_user_id"?: string }; Returns: {
              "avg_reply_seconds": number | null,"bookings_amounts": Json,"bookings_count": number,"calls_logged": number,"chats_opened": number,"chats_replied": number,"day": string,"first_seen": string | null,"full_name": string | null,"has_shift": boolean,"interested_leads": number,"last_seen": string | null,"leads_created": number,"median_reply_seconds": number | null,"payments_amounts": Json,"payments_count": number,"shift_ends": string | null,"shift_starts": string | null,"turns_answered": number,"turns_waiting": number,"user_id": string | null,"working_day": boolean
            }[]
                           },
"set_target_default":
{ Args: { "p_amount_egp": number,"p_company_id": string,"p_user_id": string }; Returns: undefined
                           },
"report_leads_per_day":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string }; Returns: {
              "automatic": number,"day": string,"manual": number,"total": number
            }[]
                           },
"report_response_speed":
{ Args: { "p_company_id": string,"p_from": string,"p_to": string }; Returns: {
              "answered": number,"answered_by_crm": number,"answered_by_phone": number,"avg_business_seconds": number,"avg_seconds": number,"business_within_15m": number,"day": string,"median_business_seconds": number,"median_seconds": number,"p90_seconds": number,"turns": number,"unanswered": number,"within_15m": number,"within_5m": number,"within_60m": number
            }[]
                           },
"report_waiting_now":
{ Args: { "p_company_id": string }; Returns: {
              "contact_name": string,"conversation_id": string,"owner_name": string,"waiting_seconds": number,"waiting_since": string
            }[]
                           },
"report_target_progress":
{ Args: { "p_company_id": string,"p_on"?: string }; Returns: {
              "actual_value": number,"attainment": number,"metric": Database["public"]['Enums']["target_metric"],"period_end": string,"period_start": string,"target_id": string,"target_value": number,"team_id": string,"user_id": string
            }[]
                           },
"report_whatsapp_account_health":
{ Args: { "p_account_id": string,"p_error_code"?: string,"p_ok": boolean }; Returns: undefined
                           },
"report_whatsapp_response":
{ Args: { "p_company_id": string,"p_from": string,"p_include_simulated"?: boolean,"p_to": string }; Returns: {
              "answered_within_15m": number,"avg_business_seconds": number,"avg_response_seconds": number,"business_within_15m": number,"full_name": string,"median_business_seconds": number,"median_response_seconds": number,"turns_answered": number,"unanswered_turns": number,"user_id": string
            }[]
                           },
"report_whatsapp_workload":
{ Args: { "p_company_ids"?: (string)[] }; Returns: {
              "company_id": string,"display_name": string,"open_conversations": number,"unassigned_conversations": number,"unread_conversations": number,"whatsapp_account_id": string
            }[]
                           },
"run_scheduled_job":
{ Args: { "p_job": string }; Returns: Json
                           },
"set_business_hours":
{ Args: { "p_company_id": string,"p_hours": Json }; Returns: undefined
                           },
"set_default_pipeline":
{ Args: { "p_pipeline_id": string }; Returns: undefined
                           },
"sync_whatsapp_templates":
{ Args: { "p_account_id": string,"p_templates": Json }; Returns: number
                           }
          }
          Enums: {
            "activity_type": "call"|"meeting"|"note"|"email"|"whatsapp"|"other","app_role": "company_admin"|"sales_manager"|"sales_agent"|"cs_agent","contact_relationship": "prospect"|"customer"|"partner"|"other","conversation_status": "open"|"pending"|"resolved","deal_status": "open"|"won"|"lost","lead_interest": "unassessed"|"interested"|"not_interested"|"follow_up_required","lead_source": "website"|"whatsapp"|"phone"|"referral"|"walk_in"|"social_media"|"campaign"|"event"|"import"|"other","lead_status": "new"|"contacted"|"qualified"|"unqualified"|"converted"|"lost","message_direction": "inbound"|"outbound","message_status": "received"|"queued"|"sent"|"delivered"|"read"|"failed","offering_kind": "course"|"workshop"|"service","pipeline_kind": "lead"|"deal","priority_level": "low"|"medium"|"high"|"urgent","stage_type": "open"|"won"|"lost","target_metric": "won_revenue"|"deals_won"|"leads_created"|"leads_contacted"|"calls_logged"|"meetings_logged"|"tasks_completed"|"collected_egp"|"paid_customers","task_status": "open"|"in_progress"|"completed"|"canceled","wa_account_status": "pending_setup"|"test"|"active"|"disabled"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "activity_type": ["call", "meeting", "note", "email", "whatsapp", "other"],"app_role": ["company_admin", "sales_manager", "sales_agent", "cs_agent"],"contact_relationship": ["prospect", "customer", "partner", "other"],"conversation_status": ["open", "pending", "resolved"],"deal_status": ["open", "won", "lost"],"lead_interest": ["unassessed", "interested", "not_interested", "follow_up_required"],"lead_source": ["website", "whatsapp", "phone", "referral", "walk_in", "social_media", "campaign", "event", "import", "other"],"lead_status": ["new", "contacted", "qualified", "unqualified", "converted", "lost"],"message_direction": ["inbound", "outbound"],"message_status": ["received", "queued", "sent", "delivered", "read", "failed"],"offering_kind": ["course", "workshop", "service"],"pipeline_kind": ["lead", "deal"],"priority_level": ["low", "medium", "high", "urgent"],"stage_type": ["open", "won", "lost"],"target_metric": ["won_revenue", "deals_won", "leads_created", "leads_contacted", "calls_logged", "meetings_logged", "tasks_completed", "collected_egp", "paid_customers"],"task_status": ["open", "in_progress", "completed", "canceled"],"wa_account_status": ["pending_setup", "test", "active", "disabled"]
          }
        }
} as const
